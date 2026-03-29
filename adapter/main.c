#include "decoder.h"
#include <stdio.h>
#include <string.h>

static int hex2bin(const char *hex, uint8_t *out) {
    int len = 0;
    while (*hex) {
        if (hex[1] == '\0') break;
        sscanf(hex, "%2hhx", &out[len++]);
        hex += 2;
    }
    return len;
}

int main(void) {
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
        printf("=== Example %d ===\n", i+1);
        if (decode_packet(buf, len, &pkt) == 0)
            print_packet(&pkt);
        else
            printf("  decode error\n");
    }
    return 0;
}