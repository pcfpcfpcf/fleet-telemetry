#ifndef MQTT_SUB_H
#define MQTT_SUB_H

#include "decoder.h"

typedef void (*mqtt_on_packet_fn)(const AVLPacket *pkt);

int  mqtt_sub_init(const char *host, int port, mqtt_on_packet_fn cb);
void mqtt_sub_loop(volatile int *running);
void mqtt_sub_close(void);

#endif
