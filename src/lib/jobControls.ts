export function legacySearchControls(job: {
  status: string;
}): { pause: boolean; resume: boolean } {
  return {
    pause: job.status === "queued" || job.status === "searching",
    resume: job.status === "paused",
  };
}
