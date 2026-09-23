import React from "react";
import { createRoot } from "react-dom/client";
import OfflineFixture from "../src/OfflineFixture";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
const publicKey =
  "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
export function mount() {
  document.getElementById("root")!.style.display = "none";
  const root = document.createElement("div");
  document.body.append(root);
  createRoot(root).render(
    <OfflineFixture
      wallet={{
        publicKey,
        address: btc.p2wpkh(hex.decode(publicKey)).address!,
        type: "p2wpkh",
      }}
    />,
  );
}
