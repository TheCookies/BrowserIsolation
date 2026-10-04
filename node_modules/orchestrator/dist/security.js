"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.randomToken = randomToken;
exports.safeEqual = safeEqual;
const node_crypto_1 = require("node:crypto");
function randomToken() {
    return (0, node_crypto_1.randomBytes)(32).toString("hex");
}
function safeEqual(left, right) {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    if (a.length !== b.length)
        return false;
    return (0, node_crypto_1.timingSafeEqual)(a, b);
}
//# sourceMappingURL=security.js.map