/** Shared helpers for worker ↔ orchestrator enrollment. */

export type WorkerEnrollResult = {
  id: string;
  token: string;
  baseUrl: string;
  publicIp: string;
  enabled: boolean;
};

export async function enrollWithOrchestrator(input: {
  orchestratorBaseUrl: string;
  enrollToken: string;
  workerId: string;
  baseUrl: string;
  publicIp: string;
}): Promise<WorkerEnrollResult> {
  const base = input.orchestratorBaseUrl.replace(/\/+$/, "");
  const response = await fetch(`${base}/api/workers/enroll`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.enrollToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      workerId: input.workerId,
      baseUrl: input.baseUrl,
      publicIp: input.publicIp,
    }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `enroll_http_${response.status}`);
  }
  return (await response.json()) as WorkerEnrollResult;
}
