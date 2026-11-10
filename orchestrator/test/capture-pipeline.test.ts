import assert from "node:assert/strict";
import test from "node:test";
import { buildNekoCapturePipelineEnv } from "../src/docker/container-runtime";

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
});
