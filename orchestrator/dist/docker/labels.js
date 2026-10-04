"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LABEL_WEBRTC_PORT = exports.LABEL_BROWSER = exports.LABEL_SESSION = exports.LABEL_OWNER = exports.LABEL_MANAGED = void 0;
exports.managedLabels = managedLabels;
exports.LABEL_MANAGED = "rbi.managed";
exports.LABEL_OWNER = "rbi.owner";
exports.LABEL_SESSION = "rbi.session";
exports.LABEL_BROWSER = "rbi.browser";
exports.LABEL_WEBRTC_PORT = "rbi.webrtc_port";
function managedLabels(input) {
    const labels = {
        [exports.LABEL_MANAGED]: "true",
        [exports.LABEL_OWNER]: input.owner,
        [exports.LABEL_SESSION]: input.sessionId,
        [exports.LABEL_BROWSER]: input.browser,
    };
    if (input.webrtcPort !== undefined) {
        labels[exports.LABEL_WEBRTC_PORT] = String(input.webrtcPort);
    }
    return labels;
}
//# sourceMappingURL=labels.js.map