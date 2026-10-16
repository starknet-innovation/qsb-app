import { reconstructConfigAScript, CURRENT_SCRIPT_VERSION } from "../src/lib/script-version";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";
// Synthetic public data for boundary/UI tests, never an owned or funded vault.
export function publicScriptFixture(version: Parameters<typeof reconstructConfigAScript>[1] = CURRENT_SCRIPT_VERSION) {
 const state = {config:"A",hash_mode:"sha256",n:150,t1s:8,t1b:1,t2s:7,t2b:2,
  hors_commitments:Array.from({length:2},()=>Array.from({length:150},()=>"ab".repeat(20))),
  dummy_sigs:Array.from({length:2},()=>Array.from({length:150},()=>"300602010102010103")),
  pin_sig:"300602010102010101", round_sigs:[{sig:"300602010102010101"},{sig:"300602010102010101"}]};
 const scriptHex=reconstructConfigAScript(state,version);
 return {publicStateJson:JSON.stringify({...state,scriptVersion:version,full_script_hex:scriptHex}),network:"mainnet",config:"A",scriptHex,scriptHash:hex.encode(sha256(hex.decode(scriptHex)))};
}
export const fixtureVault = publicScriptFixture();
