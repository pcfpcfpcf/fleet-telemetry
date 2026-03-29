#include "decoder.h"
#include <stdio.h>
#include <string.h>

static const struct { uint16_t id; const char *name; } avl_io_map[] = {
    {   1, "din1"                },
    {   2, "din2"                },
    {   3, "din3"                },
    {   4, "pulse_cnt_din1"      },
    {   5, "pulse_cnt_din2"      },
    {   6, "ain2"                },
    {   9, "ain1"                },
    {  10, "sd_status"           },
    {  11, "iccid1"              },
    {  12, "fuel_used_gps"       },
    {  13, "fuel_rate_gps"       },
    {  15, "eco_score"           },
    {  16, "odometer"            },
    {  17, "axis_x"              },
    {  18, "axis_y"              },
    {  19, "axis_z"              },
    {  21, "gsm_signal"          },
    {  24, "speed"               },
    {  66, "ext_voltage"         },
    {  67, "bat_voltage"         },
    {  68, "bat_current"         },
    {  69, "gnss_status"         },
    {  71, "dallas_id4"          },
    {  72, "dallas_temp1"        },
    {  73, "dallas_temp2"        },
    {  74, "dallas_temp3"        },
    {  75, "dallas_temp4"        },
    {  76, "dallas_id1"          },
    {  77, "dallas_id2"          },
    {  78, "ibutton"             },
    {  79, "dallas_id3"          },
    {  80, "data_mode"           },
    { 113, "bat_level"           },
    { 179, "dout1"               },
    { 180, "dout2"               },
    { 181, "gnss_pdop"           },
    { 182, "gnss_hdop"           },
    { 199, "trip_odometer"       },
    { 200, "sleep_mode"          },
    { 205, "gsm_cell_id"         },
    { 206, "gsm_area_code"       },
    { 207, "rfid"                },
    { 237, "network_type"        },
    { 238, "user_id"             },
    { 239, "ignition"            },
    { 240, "movement"            },
    { 241, "gsm_operator"        },
    { 263, "bt_status"           },
    { 303, "instant_movement"    },
    { 380, "dout3"               },
    { 381, "ground_sense"        },
    { 383, "axl_cal_status"      },
    { 636, "lte_cell_id"         },
    { 637, "wake_reason"         },
};
#define MAP_LEN (sizeof(avl_io_map) / sizeof(avl_io_map[0]))

static const char *id_to_name(uint16_t id) {
    for (size_t i = 0; i < MAP_LEN; i++)
        if (avl_io_map[i].id == id) return avl_io_map[i].name;
    return "unknown";
}

static uint8_t  r8 (const uint8_t *b, int *p) { return b[(*p)++]; }
static uint16_t r16(const uint8_t *b, int *p) {
    uint16_t v = (uint16_t)b[*p]<<8 | b[*p+1]; *p+=2; return v;
}
static uint32_t r32(const uint8_t *b, int *p) {
    uint32_t v = (uint32_t)b[*p]<<24|(uint32_t)b[*p+1]<<16
                |(uint32_t)b[*p+2]<<8|b[*p+3]; *p+=4; return v;
}
static uint64_t r64(const uint8_t *b, int *p) {
    uint64_t v = 0;
    for (int i = 0; i < 8; i++) v = (v<<8)|b[(*p)++];
    return v;
}

static int parse_io8(const uint8_t *buf, int *pos, AVLRecord *rec) {
    int n = 0;
    uint8_t n1 = r8(buf, pos);
    for (int i = 0; i < n1; i++) {
        uint8_t id = r8(buf, pos); uint8_t val = r8(buf, pos);
        rec->events[n] = (Event){ .id=id, .val=val };
        strncpy(rec->events[n].name, id_to_name(id), 49);
        n++;
    }
    uint8_t n2 = r8(buf, pos);
    for (int i = 0; i < n2; i++) {
        uint8_t id = r8(buf, pos); uint16_t val = r16(buf, pos);
        rec->events[n] = (Event){ .id=id, .val=val };
        strncpy(rec->events[n].name, id_to_name(id), 49);
        n++;
    }
    uint8_t n4 = r8(buf, pos);
    for (int i = 0; i < n4; i++) {
        uint8_t id = r8(buf, pos); uint32_t val = r32(buf, pos);
        rec->events[n] = (Event){ .id=id, .val=val };
        strncpy(rec->events[n].name, id_to_name(id), 49);
        n++;
    }
    uint8_t n8 = r8(buf, pos);
    for (int i = 0; i < n8; i++) {
        uint8_t id = r8(buf, pos); uint64_t val = r64(buf, pos);
        rec->events[n] = (Event){ .id=id, .val=(int64_t)val };
        strncpy(rec->events[n].name, id_to_name(id), 49);
        n++;
    }
    return n;
}

static int parse_io8e(const uint8_t *buf, int *pos, AVLRecord *rec) {
    int n = 0;
    uint16_t n1 = r16(buf, pos);
    for (int i = 0; i < n1; i++) {
        uint16_t id = r16(buf, pos); uint8_t val = r8(buf, pos);
        rec->events[n] = (Event){ .id=id, .val=val };
        strncpy(rec->events[n].name, id_to_name(id), 49);
        n++;
    }
    uint16_t n2 = r16(buf, pos);
    for (int i = 0; i < n2; i++) {
        uint16_t id = r16(buf, pos); uint16_t val = r16(buf, pos);
        rec->events[n] = (Event){ .id=id, .val=val };
        strncpy(rec->events[n].name, id_to_name(id), 49);
        n++;
    }
    uint16_t n4 = r16(buf, pos);
    for (int i = 0; i < n4; i++) {
        uint16_t id = r16(buf, pos); uint32_t val = r32(buf, pos);
        rec->events[n] = (Event){ .id=id, .val=val };
        strncpy(rec->events[n].name, id_to_name(id), 49);
        n++;
    }
    uint16_t n8 = r16(buf, pos);
    for (int i = 0; i < n8; i++) {
        uint16_t id = r16(buf, pos); uint64_t val = r64(buf, pos);
        rec->events[n] = (Event){ .id=id, .val=(int64_t)val };
        strncpy(rec->events[n].name, id_to_name(id), 49);
        n++;
    }
    return n;
}

static int parse_records(const uint8_t *buf, int *pos,
                         uint8_t codec_id, uint8_t num, AVLRecord *records) {
    for (int r = 0; r < num; r++) {
        AVLRecord *rec  = &records[r];
        rec->timestamp  = (int64_t)r64(buf, pos);
        rec->priority   = r8(buf, pos);
        rec->longitude  = (int32_t)r32(buf, pos);
        rec->latitude   = (int32_t)r32(buf, pos);
        rec->altitude   = (int16_t)r16(buf, pos);
        rec->angle      = r16(buf, pos);
        rec->satellites = r8(buf, pos);
        rec->speed      = r16(buf, pos);
        rec->event_io_id = r8(buf, pos);
        r8(buf, pos);   // N of total IO (we recount from groups)
        rec->event_count = (codec_id == 0x8E)
                         ? parse_io8e(buf, pos, rec)
                         : parse_io8 (buf, pos, rec);
    }
    return 0;
}

// ── TCP wrapper detection ─────────────────────────────────────────────
// Format: [2B length][2B packet_id "CAFE"][1B avl_packet_type 0x05]
//         [1B imei_length][N bytes imei ascii][AVL payload]

static int is_tcp_wrapper(const uint8_t *buf) {
    return buf[2] == 0xCA && buf[3] == 0xFE;
}

int decode_packet(const uint8_t *buf, int len, AVLPacket *out) {
    memset(out, 0, sizeof(*out));
    int pos = 0;

    if (len < 4) return -1;

    if (is_tcp_wrapper(buf)) {
        pos += 2;                          // skip length field
        pos += 2;                          // skip 0xCAFE
        pos += 1;                          // avl packet type (0x05)
        uint8_t imei_len = r8(buf, &pos);
        if (imei_len >= IMEI_LEN) return -1;
        memcpy(out->imei, buf + pos, imei_len);
        out->imei[imei_len] = '\0';
        pos += imei_len;
    }

    if (r32(buf, &pos) != 0x00000000) return -1;  // preamble
    r32(buf, &pos);                                 // data field length
    out->codec_id       = r8(buf, &pos);
    uint8_t num_records = r8(buf, &pos);
    out->count          = num_records;

    if (out->codec_id != 0x08 && out->codec_id != 0x8E) return -1;

    return parse_records(buf, &pos, out->codec_id, num_records, out->records);
}


void print_packet(const AVLPacket *p) {
    if (p->imei[0])
        printf("IMEI: %s\n", p->imei);
    printf("Codec: 0x%02X | Records: %d\n\n", p->codec_id, p->count);
    for (int r = 0; r < p->count; r++) {
        const AVLRecord *rec = &p->records[r];
        printf("  [%d] ts=%-14lld lat=%.7f lon=%.7f "
               "alt=%d spd=%u angle=%u sats=%u\n",
               r, (long long)rec->timestamp,
               rec->latitude  / 1e7,
               rec->longitude / 1e7,
               rec->altitude, rec->speed,
               rec->angle, rec->satellites);
        for (int e = 0; e < rec->event_count; e++) {
            const Event *ev = &rec->events[e];
            printf("       IO %-5d %-22s = %lld\n",
                   ev->id, ev->name, (long long)ev->val);
        }
        printf("\n");
    }
}