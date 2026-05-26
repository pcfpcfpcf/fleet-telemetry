#include "tcp-listen.h"
#include "decoder.h"
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <poll.h>

#define MAX_CLIENTS 32
#define BUF_SIZE    8192

typedef enum { STATE_IMEI, STATE_DATA } ClientState;

typedef struct {
    int         fd;
    ClientState state;
    char        imei[IMEI_LEN];
    uint8_t     buf[BUF_SIZE];
    int         buf_len;
} Client;

static int listen_fd = -1;
static Client clients[MAX_CLIENTS];
static int client_count = 0;
static tcp_on_packet_fn on_packet_cb = NULL;

static void client_remove(int idx) {
    if (clients[idx].fd >= 0) {
        close(clients[idx].fd);
        printf("[TCP] Disconnected: %s (fd=%d)\n",
               clients[idx].imei[0] ? clients[idx].imei : "unknown",
               clients[idx].fd);
    }
    clients[idx] = clients[--client_count];
}

/* Teltonika login: [2B BE imei_len][imei_len bytes ASCII IMEI]
   Server replies 0x01 (accept) or 0x00 (reject). */
static int try_read_imei(Client *c) {
    if (c->buf_len < 2) return 0;

    uint16_t imei_len = (uint16_t)c->buf[0] << 8 | c->buf[1];
    if (imei_len == 0 || imei_len >= IMEI_LEN) {
        fprintf(stderr, "[TCP] Bad IMEI length: %u\n", imei_len);
        return -1;
    }

    int total = 2 + imei_len;
    if (c->buf_len < total) return 0;

    memcpy(c->imei, c->buf + 2, imei_len);
    c->imei[imei_len] = '\0';

    int remaining = c->buf_len - total;
    if (remaining > 0) memmove(c->buf, c->buf + total, remaining);
    c->buf_len = remaining;

    uint8_t ack = 0x01;
    send(c->fd, &ack, 1, MSG_NOSIGNAL);

    printf("[TCP] Device logged in: IMEI=%s\n", c->imei);
    c->state = STATE_DATA;
    return 1;
}

/* AVL frame: [4B preamble 0x00000000][4B data_field_len][data][4B CRC]
   Server replies [4B BE number_of_records_accepted]. */
static int try_read_avl(Client *c) {
    if (c->buf_len < 12) return 0;

    uint32_t preamble = (uint32_t)c->buf[0]<<24 | (uint32_t)c->buf[1]<<16
                      | (uint32_t)c->buf[2]<<8  | c->buf[3];
    if (preamble != 0x00000000) {
        fprintf(stderr, "[TCP] Bad preamble from %s: 0x%08X\n", c->imei, preamble);
        return -1;
    }

    uint32_t data_len = (uint32_t)c->buf[4]<<24 | (uint32_t)c->buf[5]<<16
                      | (uint32_t)c->buf[6]<<8  | c->buf[7];
    if (data_len > BUF_SIZE - 12) {
        fprintf(stderr, "[TCP] Frame too large from %s: %u bytes\n", c->imei, data_len);
        return -1;
    }

    int frame_size = (int)(8 + data_len + 4);
    if (c->buf_len < frame_size) return 0;

    AVLPacket pkt;
    int ret = decode_packet(c->buf, frame_size, &pkt);

    int remaining = c->buf_len - frame_size;
    if (remaining > 0) memmove(c->buf, c->buf + frame_size, remaining);
    c->buf_len = remaining;

    if (ret != 0) {
        fprintf(stderr, "[TCP] Decode error from %s\n", c->imei);
        uint8_t ack[4] = {0, 0, 0, 0};
        send(c->fd, ack, 4, MSG_NOSIGNAL);
        return 1;
    }

    if (pkt.imei[0] == '\0' && c->imei[0] != '\0') {
        strncpy(pkt.imei, c->imei, IMEI_LEN - 1);
        pkt.imei[IMEI_LEN - 1] = '\0';
    }

    printf("[TCP] Decoded %d record(s) from %s\n", pkt.count, c->imei);

    if (on_packet_cb) on_packet_cb(&pkt);

    uint8_t ack[4];
    uint32_t n = (uint32_t)pkt.count;
    ack[0] = (n >> 24) & 0xFF;
    ack[1] = (n >> 16) & 0xFF;
    ack[2] = (n >>  8) & 0xFF;
    ack[3] =  n        & 0xFF;
    send(c->fd, ack, 4, MSG_NOSIGNAL);

    return 1;
}

int tcp_listen_init(int port, tcp_on_packet_fn cb) {
    on_packet_cb = cb;

    listen_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (listen_fd < 0) {
        perror("[TCP] socket");
        return -1;
    }

    int opt = 1;
    setsockopt(listen_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family      = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port        = htons((uint16_t)port);

    if (bind(listen_fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        perror("[TCP] bind");
        close(listen_fd);
        listen_fd = -1;
        return -1;
    }

    if (listen(listen_fd, 8) < 0) {
        perror("[TCP] listen");
        close(listen_fd);
        listen_fd = -1;
        return -1;
    }

    memset(clients, 0, sizeof(clients));
    client_count = 0;

    printf("[TCP] Listening on 0.0.0.0:%d\n", port);
    return 0;
}

void tcp_listen_loop(volatile int *running) {
    if (listen_fd < 0) return;

    while (*running) {
        struct pollfd fds[MAX_CLIENTS + 1];
        fds[0].fd     = listen_fd;
        fds[0].events = POLLIN;

        for (int i = 0; i < client_count; i++) {
            fds[i + 1].fd     = clients[i].fd;
            fds[i + 1].events = POLLIN;
        }

        int ret = poll(fds, (nfds_t)(client_count + 1), 250);
        if (ret < 0) {
            if (errno == EINTR) continue;
            perror("[TCP] poll");
            break;
        }
        if (ret == 0) continue;

        /* New connections */
        if (fds[0].revents & POLLIN) {
            struct sockaddr_in peer;
            socklen_t peer_len = sizeof(peer);
            int fd = accept(listen_fd, (struct sockaddr *)&peer, &peer_len);
            if (fd >= 0) {
                if (client_count >= MAX_CLIENTS) {
                    fprintf(stderr, "[TCP] Max clients reached, rejecting\n");
                    close(fd);
                } else {
                    Client *c = &clients[client_count++];
                    memset(c, 0, sizeof(*c));
                    c->fd    = fd;
                    c->state = STATE_IMEI;
                    printf("[TCP] Connection from %s:%d (fd=%d)\n",
                           inet_ntoa(peer.sin_addr), ntohs(peer.sin_port), fd);
                }
            }
        }

        /* Client data */
        for (int i = 0; i < client_count; i++) {
            if (!(fds[i + 1].revents & (POLLIN | POLLHUP | POLLERR)))
                continue;

            Client *c = &clients[i];
            int space = BUF_SIZE - c->buf_len;
            if (space <= 0) {
                fprintf(stderr, "[TCP] Buffer full for %s, dropping\n", c->imei);
                client_remove(i--);
                continue;
            }

            int n = (int)recv(c->fd, c->buf + c->buf_len, (size_t)space, 0);
            if (n <= 0) {
                client_remove(i--);
                continue;
            }
            c->buf_len += n;

            int ok = 1;
            while (ok > 0) {
                ok = (c->state == STATE_IMEI)
                   ? try_read_imei(c)
                   : try_read_avl(c);
            }
            if (ok < 0) {
                client_remove(i--);
            }
        }
    }
}

void tcp_listen_close(void) {
    for (int i = 0; i < client_count; i++) {
        if (clients[i].fd >= 0) close(clients[i].fd);
    }
    client_count = 0;
    if (listen_fd >= 0) {
        close(listen_fd);
        listen_fd = -1;
    }
}
