/** Trusted fixed launcher contract; public configuration never selects code, image or command. */
export type CpuOperation='pin-export-v4'|'pin-candidates-v5'|'pin-handoff-v5'|'subset-export-v5'|'subset-verify-v5';
export type ScopeBinding={runPk:string;configHash:string;operationKey:string};
export type Census={register:(entry:any)=>Promise<void>;complete:(receipt:any)=>Promise<void>};
export type OwnedRunner=(request:{operation:CpuOperation;payload:any;scopeBinding:ScopeBinding},census:Census)=>Promise<{result:any;ownedVerification:any}>;
export type Cpu={pinExport:(event:any)=>Promise<any>;pinCandidates:(event:any)=>Promise<any>;pinHandoff:(event:any)=>Promise<any>;subset:(event:any)=>Promise<any>};
export const PIN_RUNTIME='0ef53314fcf1e6307bd2249dfdb7da483ae9ae08855c36328fbeda51cda1fea0';
export const RUNTIME='14ca2c729ecee121c715b7ff1acb9b8656b8650f8f4c02e3454c1067d22edeb9';
