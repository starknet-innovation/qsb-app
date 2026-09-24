/** Pure routing contract. No chain/Store/provider/runtime calls and no deployment/default flip. */
import {z} from 'zod';
import {withdrawalSchema} from '../../../../src/lib/model';
import {assertSolverPin,assertVaultConfiguration,fingerprint,solverRelease} from '../../../../src/lib/provenance';
import {MANIFEST as PIN_IMAGE} from '../yukon-pin-preflight-20260923/execution-gate';
import {MANIFEST as SUBSET_IMAGE} from '../yukon-indexed-controller-20260923/execution-gate';
import {PIN_RUNTIME,RUNTIME} from '../yukon-owned-pin-handoff-20260923/runtime-api';
const profile={id:'qsb-supervised-pin-v4-subset-v5',protocol:'qsb-config-a-v1',generatorCommit:'2c9172051d5c150ef0a994ca6b988a08a3ef9e85',pin:{imageManifest:PIN_IMAGE,exportRuntimeHash:PIN_RUNTIME},subset:{imageManifest:SUBSET_IMAGE,solverId:'qsb-subset-tailcache-exact-owned-cleanup-v5',solverReleaseHash:'966136928aca1b7546275599a0462a1870c92b2a8d184391967a250bb16d9291'},verification:{runtimeHash:RUNTIME,operations:['pin-candidates-v5','pin-handoff-v5','subset-export-v5','subset-verify-v5']}} as const;
const archived=JSON.stringify(profile);export const supervisedProfileId=profile.id;
export function supervisedProfile(){return JSON.parse(archived) as typeof profile;}
type Vault={id:string;network?:string;config:string;scriptHex:string;scriptHash:string;publicStateJson:string;configuration?:unknown;funding?:{txid:string;vout:number;value:string}};
const requestSchema=z.object({releaseId:z.literal(profile.id)}).strict();
export type SupervisedExecution={kind:'qsb-supervised-service-v1';profile:ReturnType<typeof supervisedProfile>;profileHash:string;vaultConfigurationHash:string;publicContextHash:string;manifestHash:string;jobId:string;owner:string;vaultId:string;network:string;revision:0};
/** Caller already authenticates owner and separately performs existing chain/outpoint reservation checks. */
export function pinNewSupervisedJob(choice:unknown,owner:string,vault:Vault,manifestInput:unknown):SupervisedExecution{
 requestSchema.parse(choice);const v=structuredClone(vault),manifest=withdrawalSchema.parse(manifestInput),configuration=assertVaultConfiguration(v);
 if(!owner||manifest.vaultId!==v.id||!['regtest','testnet4','mainnet'].includes(configuration.network)||!v.funding||fingerprint(v.funding)!==fingerprint(manifest.funding))throw Error('New job/vault binding differs');
 const p=supervisedProfile();return {kind:'qsb-supervised-service-v1',profile:p,profileHash:fingerprint(p),vaultConfigurationHash:fingerprint(configuration),publicContextHash:fingerprint({publicStateJson:v.publicStateJson,manifest,network:configuration.network}),manifestHash:fingerprint(manifest),jobId:manifest.idempotencyKey,owner,vaultId:v.id,network:configuration.network,revision:0};
}
/** Stable stored routing only; queued retries cannot change profile or migrate a historical job. */
export function routeStoredJob(job:{id:string;owner:string;vaultId:string;manifest:unknown;solver?:any;execution?:unknown},vault:Vault){
 if(job.execution===undefined){const d=job.solver?assertSolverPin(job.solver,vault):solverRelease('qsb-config-a-ranked-v2-2791ed0');if(vault.configuration&&!job.solver)throw Error('SolverPinRequired');return {target:'historical-step-functions' as const,descriptor:d};}
 if(job.solver!==undefined)throw Error('Ambiguous coordinator descriptor');
 const expected=pinNewSupervisedJob({releaseId:profile.id},job.owner,vault,job.manifest);
 if(job.id!==expected.jobId||job.vaultId!==expected.vaultId||fingerprint(job.execution)!==fingerprint(expected))throw Error('Stored supervised route differs');
 return {target:'supervised-service' as const,execution:expected,dispatchAuthorized:false as const};
}
/** Proposed old coordinator's earliest guard; preserve its original release checks after this. */
export function requireHistoricalRoute(job:{execution?:unknown}){if(job.execution!==undefined)throw Error('UnsupportedCoordinatorRoute');}
