#ifndef TCP_LISTEN_H
#define TCP_LISTEN_H

#include "decoder.h"

typedef void (*tcp_on_packet_fn)(const AVLPacket *pkt);

int  tcp_listen_init(int port, tcp_on_packet_fn cb);
void tcp_listen_loop(volatile int *running);
void tcp_listen_close(void);

#endif
