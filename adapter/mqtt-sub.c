#include "mqtt-sub.h"
#include "decoder.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <time.h>
#include <mosquitto.h>

static struct mosquitto *mosq = NULL;
static mqtt_on_packet_fn on_packet_cb = NULL;

static void on_connect(struct mosquitto *m, void *userdata, int rc) {
    (void)userdata;
    if (rc != 0) {
        fprintf(stderr, "[MQTT-SUB] Connection failed: %s\n", mosquitto_connack_string(rc));
        return;
    }
    printf("[MQTT-SUB] Connected to EMQX\n");
    mosquitto_subscribe(m, NULL, "teltonika/+/codec8/raw", 1);
    printf("[MQTT-SUB] Subscribed to teltonika/+/codec8/raw\n");
}

static void on_disconnect(struct mosquitto *m, void *userdata, int rc) {
    (void)m; (void)userdata;
    fprintf(stderr, "[MQTT-SUB] Disconnected (rc=%d), reconnecting...\n", rc);
}

static void on_message(struct mosquitto *m, void *userdata,
                        const struct mosquitto_message *msg) {
    (void)m; (void)userdata;

    if (!msg->payload || msg->payloadlen < 4) {
        fprintf(stderr, "[MQTT-SUB] Ignoring empty/short message on %s\n", msg->topic);
        return;
    }

    // Extract IMEI from topic: teltonika/<imei>/codec8/raw
    char imei[IMEI_LEN] = {0};
    const char *p = msg->topic;

    // Skip "teltonika/"
    if (strncmp(p, "teltonika/", 10) == 0) {
        p += 10;
        const char *slash = strchr(p, '/');
        if (slash) {
            size_t len = (size_t)(slash - p);
            if (len >= IMEI_LEN) len = IMEI_LEN - 1;
            memcpy(imei, p, len);
            imei[len] = '\0';
        }
    }

    AVLPacket pkt;
    int ret = decode_packet((const uint8_t *)msg->payload, msg->payloadlen, &pkt);
    if (ret != 0) {
        fprintf(stderr, "[MQTT-SUB] Decode error on %s (%d bytes)\n",
                msg->topic, msg->payloadlen);
        return;
    }

    // Copy IMEI from topic into packet if decoder didn't get it (non-TCP-wrapped)
    if (pkt.imei[0] == '\0' && imei[0] != '\0') {
        strncpy(pkt.imei, imei, IMEI_LEN - 1);
        pkt.imei[IMEI_LEN - 1] = '\0';
    }

    printf("[MQTT-SUB] Decoded %d record(s) from %s\n", pkt.count, msg->topic);

    if (on_packet_cb) {
        on_packet_cb(&pkt);
    }
}

int mqtt_sub_init(const char *host, int port, mqtt_on_packet_fn cb) {
    on_packet_cb = cb;

    mosquitto_lib_init();

    // Unique client ID to prevent broker from kicking duplicate sessions
    char client_id[64];
    snprintf(client_id, sizeof(client_id), "fleet-adapter-%d-%ld",
             (int)getpid(), (long)time(NULL));

    mosq = mosquitto_new(client_id, true, NULL);
    if (!mosq) {
        fprintf(stderr, "[MQTT-SUB] Failed to create mosquitto instance\n");
        return -1;
    }

    mosquitto_connect_callback_set(mosq, on_connect);
    mosquitto_disconnect_callback_set(mosq, on_disconnect);
    mosquitto_message_callback_set(mosq, on_message);

    mosquitto_reconnect_delay_set(mosq, 2, 30, true);

    printf("[MQTT-SUB] Connecting to %s:%d as %s\n", host, port, client_id);

    int rc = mosquitto_connect(mosq, host, port, 60);
    if (rc != MOSQ_ERR_SUCCESS) {
        fprintf(stderr, "[MQTT-SUB] Connect failed: %s\n", mosquitto_strerror(rc));
        mosquitto_destroy(mosq);
        mosq = NULL;
        return -1;
    }

    return 0;
}

void mqtt_sub_loop(volatile int *running) {
    if (!mosq) return;
    while (*running) {
        int rc = mosquitto_loop(mosq, 250, 1);
        if (rc != MOSQ_ERR_SUCCESS && *running) {
            fprintf(stderr, "[MQTT-SUB] Loop error: %s, reconnecting in 3s...\n",
                    mosquitto_strerror(rc));
            sleep(3);
            mosquitto_reconnect(mosq);
        }
    }
}

void mqtt_sub_close(void) {
    if (mosq) {
        mosquitto_disconnect(mosq);
        mosquitto_destroy(mosq);
        mosq = NULL;
    }
    mosquitto_lib_cleanup();
}
