import { expect, it } from "vitest";
import { nativeStartup } from "../ops/pqb-serving/native-startup";
import validation from "../server/aws-batch-validation.json";

const device = `${validation.gpuName}, GPU-01234567-89ab-cdef-0123-456789abcdef, 580.178.04`;
const queue = `arn:aws:batch:eu-west-2:123456789012:job-queue/${validation.name}`;
const isolation = "NoNewPrivs:\t1\nCapBnd:\t0000000000000000";

it("binds the native startup to the selected GPU and process isolation", () => {
  expect(nativeStartup([device, isolation], queue)).toEqual({ gpuModel: validation.gpuName,
    gpuUuid: "GPU-01234567-89ab-cdef-0123-456789abcdef", driver: "580.178.04" });
  expect(nativeStartup([`NVIDIA ${device}\n${isolation}`], queue).gpuModel).toBe(validation.gpuName);
});

it.each([
  [device.replace(validation.gpuName, "A10G"), isolation],
  [device, device, isolation],
  [device],
  [device, isolation.replace("NoNewPrivs:\t1", "NoNewPrivs:\t0")],
  [device, isolation.replace("0000000000000000", "0000000000000001")],
  [device.replace("580.178.04", "unknown"), isolation],
  [isolation],
])("rejects missing or mismatched native startup evidence %#", (...messages) => {
  expect(() => nativeStartup(messages, queue)).toThrow("receipt missing");
});

it("preserves the ordinary A10G queue audit and rejects unknown queues", () => {
  const productionQueue = queue.replace(validation.name, "qsb-gpu");
  const a10g = device.replace(validation.gpuName, "A10G");
  expect(nativeStartup([a10g, isolation], productionQueue).gpuModel).toBe("A10G");
  expect(() => nativeStartup([device, isolation], productionQueue)).toThrow("receipt missing");
  expect(() => nativeStartup([device, isolation], queue + "-other")).toThrow("receipt missing");
});
