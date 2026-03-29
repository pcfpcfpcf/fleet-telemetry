#include <stdint.h>
#include <string.h>
#include <stdlib.h>

#define MAX_IO_PER_RECORD 64
#define MAX_RECORDS       255
#define IMEI_LEN          16

typedef struct {
    int64_t  val;
    int      id;
    char     name[50];
} Event;

typedef struct {
    int64_t  timestamp;
    int32_t  longitude;   // divide by 1e7 for degrees
    int32_t  latitude;
    int16_t  altitude;
    uint16_t angle;
    uint16_t speed;
    uint8_t  priority;
    uint8_t  satellites;
    uint8_t  event_io_id;
    int      event_count;
    Event    events[MAX_IO_PER_RECORD];
} AVLRecord;

typedef struct {
    char      imei[IMEI_LEN];  // populated only from TCP-wrapped packets
    AVLRecord records[MAX_RECORDS];
    uint8_t   codec_id;
    int       count;
} AVLPacket;

// forward declarations
int  decode_packet (const uint8_t *buf, int len, AVLPacket *out);
void print_packet  (const AVLPacket *p);