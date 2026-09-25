import { expect, it } from "vitest";
import {
  gpuSpendLimits,
  gpuSpendSchema,
  nextGpuReservation,
} from "../server/gpu-spend";
const fresh = {
  computeSeconds: 0,
  gpuBudgetReservedSeconds: 0,
  stage: "pinning",
  attempt: 0,
};
it("configures the selected 48 GPU-hours in one bundled value", () => {
  expect(gpuSpendLimits.maxJobGpuSeconds).toBe(48 * 3600);
  expect(
    gpuSpendSchema.parse({ ...gpuSpendLimits, maxJobGpuSeconds: 3600 })
      .maxJobGpuSeconds,
  ).toBe(3600);
  for (const maxJobGpuSeconds of [null, 0, -1, 1.5, 31536001, Infinity, NaN])
    expect(() =>
      gpuSpendSchema.parse({ ...gpuSpendLimits, maxJobGpuSeconds }),
    ).toThrow();
});
it("reserves fresh jobs and migrates historical submission counts conservatively", () => {
  expect(nextGpuReservation(fresh, 900000)).toBe(900);
  expect(
    nextGpuReservation(
      { ...fresh, gpuSubmissions: 7, gpuBudgetReservedSeconds: undefined },
      900000,
    ),
  ).toBe(7200);
  expect(
    nextGpuReservation({ ...fresh, gpuBudgetReservedSeconds: 172800 }, 900000),
  ).toBe(173700);
});
it("never refunds reservations and floors accounting at observed compute", () => {
  expect(
    nextGpuReservation(
      { ...fresh, computeSeconds: 1, gpuBudgetReservedSeconds: 900 },
      900000,
    ),
  ).toBe(1800);
  expect(
    nextGpuReservation(
      { ...fresh, computeSeconds: 1800.1, gpuBudgetReservedSeconds: 900 },
      900000,
    ),
  ).toBe(2701);
});
it("fails closed on missing historical or invalid accounting", () => {
  for (const extra of [
    { gpuBudgetReservedSeconds: undefined },
    { gpuBudgetReservedSeconds: undefined, computeSeconds: 1 },
    { gpuSubmissions: -1 },
    { gpuSubmissions: 1.5 },
    { gpuBudgetReservedSeconds: NaN },
    { gpuBudgetReservedSeconds: -1 },
    { computeSeconds: Infinity },
    { gpuBudgetReservedSeconds: Number.MAX_SAFE_INTEGER },
  ])
    expect(() => nextGpuReservation({ ...fresh, ...extra }, 900000)).toThrow(
      /accounting/,
    );
});
