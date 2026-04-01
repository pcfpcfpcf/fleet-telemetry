#ifndef NATS_PUB_H
#define NATS_PUB_H

#include "decoder.h"
#include <nats/nats.h>

int nats_pub_init(const char *url);

void nats_pub_packet(const AVLPacket *pkt);

void nats_pub_close(void);

#endif 