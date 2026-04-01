#include "nats-pub.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static natsConnection *conn = NULL;
static jsCtx *js = NULL;

int nats_pub_init(const char *url) {
    natsStatus s;
    natsOptions *opts = NULL;

    s = natsOptions_Create(&opts);
    if (s == NATS_OK && url) {
        s = natsOptions_SetURL(opts, url);
    }
    if (s == NATS_OK) {
        s = natsConnection_Connect(&conn, opts);
    }
    if (s == NATS_OK) {
        s = natsConnection_JetStream(&js, conn, NULL);
    }
    
    natsOptions_Destroy(opts);

    if (s != NATS_OK) {
        fprintf(stderr, "Error connecting to NATS: %s\n", natsStatus_GetText(s));
        if (conn) {
            natsConnection_Destroy(conn);
            conn = NULL;
        }
        return -1;
    }

    printf("[NATS-PUB] Connected to NATS\n");
    return 0;
}

static void format_iso8601(int64_t ts_ms, char *out, size_t sz) {
    time_t s = ts_ms / 1000;
    int ms = ts_ms % 1000;
    struct tm tm_info;
    gmtime_r(&s, &tm_info);
    char buf[32];
    strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%S", &tm_info);
    snprintf(out, sz, "%s.%03dZ", buf, ms);
}

static void sanitize_device_id(const char *in, char *out, size_t sz) {
    for (size_t i = 0; i < sz - 1 && in[i] != '\0'; i++) {
        char c = in[i];
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || 
            (c >= '0' && c <= '9') || c == '_' || c == '-') {
            out[i] = c;
        } else {
            out[i] = '_';
        }
        out[i+1] = '\0';
    }
    if (in[0] == '\0') out[0] = '\0';
}

static void gen_uuid(char *out, size_t sz) {
    if (sz < 37) return;
    srand((unsigned int)time(NULL) + rand());
    snprintf(out, sz, "%08x-%04x-%04x-%04x-%08x%04x",
             rand(), rand() & 0xffff,
             ((rand() & 0x0fff) | 0x4000),
             ((rand() & 0x3fff) | 0x8000),
             rand(), rand() & 0xffff);
}

static int get_io_value(const AVLRecord *rec, int id, int64_t *val) {
    for (int i = 0; i < rec->event_count; i++) {
        if (rec->events[i].id == id) {
            *val = rec->events[i].val;
            return 1;
        }
    }
    return 0;
}

void nats_pub_packet(const AVLPacket *pkt) {
    if (!js || !conn) return;

    char device_id[32] = "unknown_device";
    if (strlen(pkt->imei) > 0) {
        strncpy(device_id, pkt->imei, sizeof(device_id));
    }
    device_id[sizeof(device_id)-1] = '\0';

    char safe_device_id[32];
    sanitize_device_id(device_id, safe_device_id, sizeof(safe_device_id));

    char subject[128];
    snprintf(subject, sizeof(subject), "telemetry.raw.%s", safe_device_id);

    char received_at[32];
    int64_t now_ms = (int64_t)time(NULL) * 1000;
    format_iso8601(now_ms, received_at, sizeof(received_at));

    for (int i = 0; i < pkt->count; i++) {
        const AVLRecord *rec = &pkt->records[i];
        char timestamp[32];
        format_iso8601(rec->timestamp, timestamp, sizeof(timestamp));

        char event_id[64];
        gen_uuid(event_id, sizeof(event_id));

        int64_t fuel = 0, ignition = 0, odometer = 0, rpm = 0, engine_load = 0;
        int has_fuel = get_io_value(rec, 12, &fuel) || get_io_value(rec, 13, &fuel);
        int has_ignition = get_io_value(rec, 239, &ignition);
        int has_odometer = get_io_value(rec, 16, &odometer);
        int has_rpm = 0;
        int has_engine_load = 0;

        char io_events_json[2048] = "[";
        int json_len = 1;
        for (int e = 0; e < rec->event_count; e++) {
            char io[128];
            int n = snprintf(io, sizeof(io), "{\"id\":%d,\"name\":\"%s\",\"value\":%lld}%s", 
                             rec->events[e].id, rec->events[e].name, (long long)rec->events[e].val,
                             (e < rec->event_count - 1) ? "," : "");
            if (json_len + n < (int)sizeof(io_events_json)) {
                strcat(io_events_json, io);
                json_len += n;
            }
        }
        strcat(io_events_json, "]");

        char st_ignition[16] = "null"; if(has_ignition) snprintf(st_ignition, sizeof(st_ignition), ignition ? "true" : "false");
        char st_fuel[32] = "null"; if(has_fuel) snprintf(st_fuel, sizeof(st_fuel), "%lld", (long long)fuel);
        char st_odo[32]  = "null"; if(has_odometer) snprintf(st_odo, sizeof(st_odo), "%lld", (long long)odometer);
        char st_rpm[32]  = "null"; if(has_rpm) snprintf(st_rpm, sizeof(st_rpm), "%lld", (long long)rpm);
        char st_load[32] = "null"; if(has_engine_load) snprintf(st_load, sizeof(st_load), "%lld", (long long)engine_load);

        char payload[4096];
        snprintf(payload, sizeof(payload),
            "{"
            "\"event_id\":\"%s\","
            "\"device_id\":\"%s\","
            "\"timestamp\":\"%s\","
            "\"received_at\":\"%s\","
            "\"position\":{"
            "\"lat\":%.7f,"
            "\"lng\":%.7f,"
            "\"altitude\":%d,"
            "\"accuracy\":null,"
            "\"bearing\":%u,"
            "\"speed\":%u"
            "},"
            "\"telemetry\":{"
            "\"ignition\":%s,"
            "\"fuel_level\":%s,"
            "\"odometer\":%s,"
            "\"rpm\":%s,"
            "\"engine_load\":%s"
            "},"
            "\"io_events\":%s,"
            "\"buffered\":false"
            "}",
            event_id, device_id, timestamp, received_at,
            rec->latitude / 1e7, rec->longitude / 1e7, rec->altitude, rec->angle, rec->speed,
            st_ignition, st_fuel, st_odo, st_rpm, st_load,
            io_events_json
        );

        natsStatus s = natsConnection_Publish(conn, subject, payload, (int)strlen(payload));
        if (s != NATS_OK) {
            fprintf(stderr, "[NATS-PUB] Error publishing: %s\n", natsStatus_GetText(s));
        } else {
            printf("[NATS-PUB] Published event %s to NATS JetStream subject %s\n", event_id, subject);
        }
    }
}

void nats_pub_close(void) {
    if (js) {
        jsCtx_Destroy(js);
        js = NULL;
    }
    if (conn) {
        natsConnection_Destroy(conn);
        conn = NULL;
    }
}
