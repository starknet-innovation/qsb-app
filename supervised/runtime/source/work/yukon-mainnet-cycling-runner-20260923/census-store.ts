import {DynamoStore,type Store,type Row} from '../../outputs/qsb-vault/server/store';
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,QueryCommand} from '@aws-sdk/lib-dynamodb';
export interface CensusStore extends Store {all(pk:string):Promise<Row[]>}
/** Trusted configured backend. Consistent paginated partition inventory, no empty begins_with filter. */
export class DynamoCensusStore extends DynamoStore implements CensusStore {
 private censusClient=DynamoDBDocumentClient.from(new DynamoDBClient({region:process.env.AWS_REGION}));
 constructor(private censusTable:string){super(censusTable);}
 async all(pk:string){const rows:Row[]=[];let cursor:Record<string,any>|undefined;do{const r=await this.censusClient.send(new QueryCommand({TableName:this.censusTable,KeyConditionExpression:'pk=:p',ExpressionAttributeValues:{':p':pk},ConsistentRead:true,ExclusiveStartKey:cursor}));rows.push(...(r.Items??[]) as Row[]);cursor=r.LastEvaluatedKey;}while(cursor);return rows;}
}
