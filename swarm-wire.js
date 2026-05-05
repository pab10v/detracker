/**
 * DeTracker Swarm P2P wire format v1 — binario mínimo (sin MessagePack ni JSON en el canal).
 * Trama: MAGIC(4) + version(1) + opcode(1) + cuerpo...
 *
 * Opcodes: 1=PING, 2=PONG, 3=IMPRINT
 * Endianness: big-endian para multi-byte; timestamps como float64 IEEE754 (ms desde epoch).
 */
(function (global) {
    const MAGIC = new Uint8Array([0x44, 0x54, 0x53, 0x31]); // "DTS1"
    const VERSION = 1;
    const OP_PING = 1;
    const OP_PONG = 2;
    const OP_IMPRINT = 3;
    const HEADER = 6;
    const MAX_STR = 4096;

    const textEnc = new TextEncoder();
    const textDec = new TextDecoder();

    function readU16BE(u8, o) {
        return (u8[o] << 8) | u8[o + 1];
    }

    function writeU16BE(dv, o, v) {
        dv.setUint16(o, v, false);
    }

    function readF64BE(dv, o) {
        return dv.getFloat64(o, false);
    }

    function writeF64BE(dv, o, v) {
        dv.setFloat64(o, v, false);
    }

    function checkMagic(u8) {
        return u8.length >= 4
            && u8[0] === MAGIC[0] && u8[1] === MAGIC[1]
            && u8[2] === MAGIC[2] && u8[3] === MAGIC[3];
    }

    function toUint8View(raw) {
        if (raw instanceof Uint8Array) return raw;
        if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
        if (raw && ArrayBuffer.isView(raw)) {
            return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
        }
        return null;
    }

    /**
     * @param {{ type: string, payload?: object }} obj
     * @returns {Uint8Array|null}
     */
    function encode(obj) {
        if (!obj || typeof obj.type !== 'string') return null;
        const pay = obj.payload || {};
        let opcode;
        if (obj.type === 'SWARM_V1_PING') opcode = OP_PING;
        else if (obj.type === 'SWARM_V1_PONG') opcode = OP_PONG;
        else if (obj.type === 'SWARM_V1_IMPRINT') opcode = OP_IMPRINT;
        else return null;

        if (opcode === OP_PING) {
            const flags = pay.immediate ? 1 : 0;
            const t = Number(pay.t) || 0;
            const buf = new ArrayBuffer(HEADER + 1 + 8);
            const u8 = new Uint8Array(buf);
            const dv = new DataView(buf);
            u8.set(MAGIC, 0);
            u8[4] = VERSION;
            u8[5] = opcode;
            u8[6] = flags;
            writeF64BE(dv, 7, t);
            return u8;
        }

        if (opcode === OP_PONG) {
            const t = Number(pay.t) || 0;
            const at = Number(pay.at) || 0;
            const buf = new ArrayBuffer(HEADER + 16);
            const u8 = new Uint8Array(buf);
            const dv = new DataView(buf);
            u8.set(MAGIC, 0);
            u8[4] = VERSION;
            u8[5] = opcode;
            writeF64BE(dv, 6, t);
            writeF64BE(dv, 14, at);
            return u8;
        }

        const uuid = String(pay.uuid || '');
        const behaviorHash = String(pay.behaviorHash || '');
        const target = String(pay.target || '');
        const timestamp = Number(pay.timestamp) || 0;

        const bu = textEnc.encode(uuid);
        const bb = textEnc.encode(behaviorHash);
        const bt = textEnc.encode(target);
        if (bu.length > MAX_STR || bb.length > MAX_STR || bt.length > MAX_STR) return null;

        const total = HEADER + 2 + bu.length + 2 + bb.length + 2 + bt.length + 8;
        const buf = new ArrayBuffer(total);
        const u8 = new Uint8Array(buf);
        const dv = new DataView(buf);
        let o = 0;
        u8.set(MAGIC, o); o += 4;
        u8[o++] = VERSION;
        u8[o++] = opcode;
        writeU16BE(dv, o, bu.length); o += 2;
        u8.set(bu, o); o += bu.length;
        writeU16BE(dv, o, bb.length); o += 2;
        u8.set(bb, o); o += bb.length;
        writeU16BE(dv, o, bt.length); o += 2;
        u8.set(bt, o); o += bt.length;
        writeF64BE(dv, o, timestamp);
        return u8;
    }

    /**
     * @param {ArrayBuffer|Uint8Array} raw
     * @returns {{ type: string, payload: object }|null}
     */
    function decode(raw) {
        const u8 = toUint8View(raw);
        if (!u8 || u8.length < HEADER) return null;
        if (!checkMagic(u8)) return null;
        if (u8[4] !== VERSION) return null;

        const opcode = u8[5];
        const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

        if (opcode === OP_PING) {
            if (u8.length < HEADER + 1 + 8) return null;
            const flags = u8[6];
            const t = readF64BE(dv, 7);
            return { type: 'SWARM_V1_PING', payload: { t, immediate: !!(flags & 1) } };
        }

        if (opcode === OP_PONG) {
            if (u8.length < HEADER + 16) return null;
            const t = readF64BE(dv, 6);
            const at = readF64BE(dv, 14);
            return { type: 'SWARM_V1_PONG', payload: { t, at } };
        }

        if (opcode === OP_IMPRINT) {
            let o = HEADER;
            if (o + 2 > u8.length) return null;
            const lu = readU16BE(u8, o); o += 2;
            if (lu > MAX_STR || o + lu > u8.length) return null;
            const uuid = textDec.decode(u8.subarray(o, o + lu)); o += lu;
            if (o + 2 > u8.length) return null;
            const lb = readU16BE(u8, o); o += 2;
            if (lb > MAX_STR || o + lb > u8.length) return null;
            const behaviorHash = textDec.decode(u8.subarray(o, o + lb)); o += lb;
            if (o + 2 > u8.length) return null;
            const lt = readU16BE(u8, o); o += 2;
            if (lt > MAX_STR || o + lt + 8 > u8.length) return null;
            const target = textDec.decode(u8.subarray(o, o + lt)); o += lt;
            const timestamp = readF64BE(dv, o);
            return { type: 'SWARM_V1_IMPRINT', payload: { uuid, behaviorHash, target, timestamp } };
        }

        return null;
    }

    global.SwarmWire = { encode, decode, toUint8View, WIRE_VERSION: VERSION };
})(typeof self !== 'undefined' ? self : globalThis);
