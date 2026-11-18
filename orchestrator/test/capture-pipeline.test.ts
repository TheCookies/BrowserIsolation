import assert from "node:assert/strict";
import test from "node:test";
import {
  buildNekoAudioCaptureEnv,
  buildNekoCapturePipelineEnv,
} from "../src/docker/container-runtime";

function envMap(rows: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const eq = row.indexOf("=");
    assert.ok(eq > 0, `expected KEY=value, got ${row}`);
    out[row.slice(0, eq)] = row.slice(eq + 1);
  }
  return out;
}

test("vp8 capture env hardcodes show-pointer=false for main and legacy", () => {
  const env = envMap(buildNekoCapturePipelineEnv({ captureVideoCodec: "vp8" }));
  assert.equal(env.NEKO_CAPTURE_VIDEO_CODEC, "vp8");
  assert.equal(env.NEKO_CAPTURE_VIDEO_IDS, "main");
  assert.equal(env.NEKO_CAPTURE_VIDEO_SHOW_POINTER, "false");
  assert.equal(env.NEKO_CAPTURE_VIDEO_PIPELINE, undefined);

  const pipelines = JSON.parse(env.NEKO_CAPTURE_VIDEO_PIPELINES) as Record<
    string,
    { gst_pipeline: string }
  >;
  assert.ok(pipelines.main?.gst_pipeline.includes("show-pointer=false"));
  assert.ok(pipelines.legacy?.gst_pipeline.includes("show-pointer=false"));
  assert.ok(!pipelines.main.gst_pipeline.includes("show-pointer=true"));
  assert.ok(!pipelines.legacy.gst_pipeline.includes("show-pointer=true"));
  assert.ok(pipelines.main.gst_pipeline.includes("vp8enc"));
  assert.ok(pipelines.main.gst_pipeline.includes("leaky=downstream"));
  assert.ok(pipelines.main.gst_pipeline.includes("max-size-buffers=2"));
});

test("h264 capture env hardcodes show-pointer=false for main and legacy", () => {
  const env = envMap(buildNekoCapturePipelineEnv({ captureVideoCodec: "h264" }));
  assert.equal(env.NEKO_CAPTURE_VIDEO_CODEC, "h264");
  assert.equal(env.NEKO_CAPTURE_VIDEO_IDS, "main");
  assert.equal(env.NEKO_CAPTURE_VIDEO_SHOW_POINTER, "false");
  assert.equal(env.NEKO_CAPTURE_VIDEO_PIPELINE, undefined);

  const pipelines = JSON.parse(env.NEKO_CAPTURE_VIDEO_PIPELINES) as Record<
    string,
    { gst_pipeline: string }
  >;
  assert.ok(pipelines.main?.gst_pipeline.includes("show-pointer=false"));
  assert.ok(pipelines.legacy?.gst_pipeline.includes("show-pointer=false"));
  assert.ok(pipelines.main.gst_pipeline.includes("x264enc"));
  assert.ok(pipelines.main.gst_pipeline.includes("leaky=downstream"));
});

test("audio capture records the pulse sink the browser plays into", () => {
  const env = envMap(buildNekoAudioCaptureEnv());
  assert.equal(env.PULSE_SERVER, "unix:/tmp/pulseaudio.socket");
  assert.equal(env.PULSE_SINK, "audio_output");
  assert.equal(env.NEKO_CAPTURE_AUDIO_DEVICE, "audio_output.monitor");
  assert.equal(env.NEKO_CAPTURE_AUDIO_CODEC, "opus");
  const pipeline = env.NEKO_CAPTURE_AUDIO_PIPELINE;
  assert.ok(pipeline.includes("pulsesrc device={device}"));
  assert.ok(pipeline.includes("opusenc"));
  assert.ok(pipeline.includes("appsink name=appsink"));
  assert.equal(pipeline.includes("show-pointer"), false);
});
