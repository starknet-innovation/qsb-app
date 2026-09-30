export function legacySearchControls(job: {
  status: string;
  execution?: { kind?: string };
}): { pause: boolean; resume: boolean; authorize: boolean } {
  if (job.execution?.kind === "qsb-supervised-service-v1")
    return { pause: false, resume: false, authorize: false };
  return {
    pause: job.status === "queued" || job.status === "searching",
    resume: job.status === "paused",
    authorize: job.status === "awaiting_authorization",
  };
}
