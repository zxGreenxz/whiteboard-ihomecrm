/** Required numeric data must not become a financial zero after a broken response. */
export function financialReadNumber(value:unknown):number {
 if((typeof value!=='number' && typeof value!=='string') || (typeof value==='string'&&!value.trim()) || !Number.isFinite(Number(value))) throw new TypeError('Chưa đọc được đầy đủ số liệu tài chính.');
 return Number(value);
}
export function financialReadRows<T>(value:T[]|null|undefined):T[] {
 if(!Array.isArray(value)) throw new TypeError('Chưa đọc được đầy đủ danh sách tài chính.');
 return value;
}
