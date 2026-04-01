#include "decoder.h"
#include "nats-pub.h"
#include "mqtt-sub.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>

static volatile int running = 1;

static void sighandler(int sig) {
    (void)sig;
    running = 0;
    printf("\n[ADAPTER] Shutting down...\n");
}

static void on_packet(const AVLPacket *pkt) {
    print_packet(pkt);
    nats_pub_packet(pkt);
}

static int hex2bin(const char *hex, uint8_t *out) {
    int len = 0;
    while (*hex) {
        if (hex[1] == '\0') break;
        sscanf(hex, "%2hhx", &out[len++]);
        hex += 2;
    }
    return len;
}

static void run_debug_examples(void) {
    printf("[ADAPTER] DEBUG mode — running hardcoded examples\n\n");

    const char *examples[] = {
        "000000000000003608010000016B40D8EA30010000000000000000000000000000000105021503010101425E0F01F10000601A014E0000000000000000010000C7CF",
        "000000000000002808010000016B40D9AD80010000000000000000000000000000000103021503010101425E100000010000F22A",
        "000000000000004308020000016B40D57B480100000000000000000000000000000001010101000000000000016B40D5C198010000000000000000000000000000000101010101000000020000252C",
        "003DCAFE0105000F33353230393330383634303336353508010000016B4F815B30010000000000000000000000000000000103021503010101425DBC000001",
        NULL
    };

    uint8_t buf[512];
    for (int i = 0; examples[i]; i++) {
        int len = hex2bin(examples[i], buf);
        AVLPacket pkt;
        printf("=== Example %d ===\n", i + 1);
        if (decode_packet(buf, len, &pkt) == 0) {
            on_packet(&pkt);
        } else {
            printf("  decode error\n");
        }
    }
}

int main() {
    signal(SIGINT,  sighandler);
    signal(SIGTERM, sighandler);

    printf("=== Fleet Telemetry Adapter (C) ===\n\n");

    // NATS
    const char *nats_url = getenv("NATS_URL");
    if (!nats_url) nats_url = "nats://localhost:4222";

    if (nats_pub_init(nats_url) != 0) {
        fprintf(stderr, "[ADAPTER] Failed to connect to NATS\n");
        return 1;
    }

    // DEBUG mode: run examples and exit
    const char *debug = getenv("DEBUG");
    if (debug && debug[0] == '1') {
        run_debug_examples();
        nats_pub_close();
        return 0;
    }

    // MQTT
    const char *mqtt_host = getenv("MQTT_HOST");
    if (!mqtt_host) mqtt_host = "localhost";

    int mqtt_port = 1883;
    const char *port_str = getenv("MQTT_PORT");
    if (port_str) mqtt_port = atoi(port_str);

    if (mqtt_sub_init(mqtt_host, mqtt_port, on_packet) != 0) {
        fprintf(stderr, "[ADAPTER] Failed to connect to EMQX\n");
        nats_pub_close();
        return 1;
    }

    printf("[ADAPTER] Running: EMQX (%s:%d) -> decode -> NATS (%s)\n\n",
           mqtt_host, mqtt_port, nats_url);

    // Blocks until SIGINT/SIGTERM
    mqtt_sub_loop(&running);

    mqtt_sub_close();
    nats_pub_close();
    printf("[ADAPTER] Shutdown complete\n");
    return 0;
}