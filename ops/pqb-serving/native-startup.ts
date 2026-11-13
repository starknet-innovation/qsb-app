import validation from "../../server/aws-batch-validation.json";

/** Check collected native logs against the hardware selected by the committed profile. */
export function nativeStartup(messages: string[], queue: string) {
  const identity = /^arn:aws:batch:([^:]+):\d{12}:job-queue\/([^/]+)$/.exec(queue);
  const expected = identity?.[2] === validation.name && validation.regions.includes(identity[1])
    ? validation.gpuName : identity?.[2] === "qsb-gpu" && identity[1] === "eu-west-2" ? "A10G" : undefined;
  const lines = messages.flatMap(message => message.split("\n"));
  const devices = lines.map(line => /^(?:NVIDIA )?([^,]+),\s*(GPU-[a-f0-9-]+),\s*([0-9]+(?:\.[0-9]+)+)\s*$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null);
  const device = devices[0];
  if (devices.length !== 1 || !expected || device[1] !== expected
    || !lines.some(line => /^NoNewPrivs:\s+1\s*$/.test(line))
    || !lines.some(line => /^CapBnd:\s+0+\s*$/.test(line)))
    throw Error("Configured GPU driver or process-isolation receipt missing");
  return { gpuModel: device[1], gpuUuid: device[2], driver: device[3] };
}
