import {financialReadNumber} from './financialReadValidation';
/** contracts.rent_price/total_deposit are numeric(15,2); PostgreSQL rounds decimal ties away from zero. */
function storedCents(value:number):bigint {
 // String.split always returns a first segment; the exponent segment is optional.
 const [mantissa,exponent='0']=Math.abs(value).toString().toLowerCase().split('e') as [string,string?];
 const [whole,fraction='']=mantissa.split('.') as [string,string?];const digits=BigInt(whole+fraction);const power=2+Number(exponent)-fraction.length;
 const magnitude=power>=0?digits*10n**BigInt(power):(()=>{const divisor=10n**BigInt(-power);return digits/divisor+(digits%divisor*2n>=divisor?1n:0n);})();
 return value<0?-magnitude:magnitude;
}
export function matchesContractMoneyReceipt(value:unknown,requested:unknown):boolean {
 const actual=financialReadNumber(value);const expected=financialReadNumber(requested);const cents=storedCents(actual);
 if(Number(cents)/100!==actual)throw new TypeError('Unconfirmed stored contract money precision');
 return cents===storedCents(expected);
}
