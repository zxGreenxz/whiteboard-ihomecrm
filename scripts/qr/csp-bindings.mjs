import { createHash } from 'node:crypto';

export const sourceHashes = {
  wechat: '0a6cc1f8e876893a071f613fde9f4caa0018f090015aafbef2b4644af841b862',
  opencv: 'bd0c3e6448043de04f6a64a12cb7b759f78c3ab8f7c35c9f2e0f71c88bb17103',
};
export const sha256 = data => createHash('sha256').update(data).digest('hex');

// These closures replace only the seven generated binding factories in the
// hash-pinned distributions. They deliberately preserve upstream error/cleanup
// order (including not running destructors when conversion/invocation throws).
// Application-owned cv objects are released separately by the adapter's finally.
function invoker(name, legal, fail, destruct) {
  return `function ${name}(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc) {
    var count=argTypes.length;
    if(count<2) ${fail}("argTypes array size mismatch! Must at least get return value and 'this' types!");
    var method=argTypes[1]!==null&&classType!==null;
    var stack=argTypes.slice(1).some(function(t){return t!==null&&t.destructorFunction===undefined});
    var fn=function() {
      if(arguments.length!==count-2) ${fail}("function "+humanName+" called with "+arguments.length+" arguments, expected "+(count-2)+" args!");
      var dtors=stack?[]:null,wired=[],args=[cppTargetFunc];
      if(method){wired[1]=argTypes[1].toWireType(dtors,this==null?globalThis:Object(this));args.push(wired[1])}
      for(var i=2;i<count;i++){wired[i]=argTypes[i].toWireType(dtors,arguments[i-2]);args.push(wired[i])}
      var rv=cppInvokerFunc.apply(undefined,args);
      if(stack) ${destruct}(dtors);
      else for(var i=method?1:2;i<count;i++) if(argTypes[i].destructorFunction!==null) {
        var dtor=argTypes[i].destructorFunction; dtor(wired[i]);
      }
      if(argTypes[0].name!=="void") return argTypes[0].fromWireType(rv);
    };
    Object.defineProperties(fn,{name:{value:${legal}(humanName),configurable:true},length:{value:count-2,configurable:true}});
    return fn;
  }`;
}
function method(name, lookup, legal, register, cache) {
  return `function ${name}(count,ptr) {
    var types=${lookup}(count,ptr),ret=types[0],returns=!ret.isVoid,signature=ret.name+"_$"+types.slice(1).map(function(t){return t.name}).join("_")+"$";
    ${cache ? 'if(dI[signature]!==undefined)return dI[signature];' : ''}
    var fn=function(handle,name,destructors,args) {
      var values=[],offset=0;
      for(var i=1;i<count;i++){values.push(types[i].readValueFromPointer(args+offset));offset+=types[i].argPackAdvance}
      var rv=handle[name].apply(handle,values);
      for(var i=1;i<count;i++) if(types[i].deleteObject) types[i].deleteObject(values[i-1]);
      if(returns)return ret.toWireType(destructors,rv);
    };
    Object.defineProperty(fn,"name",{value:${legal}("methodCaller_"+signature),configurable:true});
    var result=${register}(fn); ${cache ? 'dI[signature]=result;' : ''} return result;
  }`;
}
export function bindingPatches(kind) {
  if (kind === 'wechat') return [
    { kind: 'named', start: 'function tA(A,I)', end: 'function XA(', replacement: 'function tA(A,I){A=JA(A);var fn=function(){"use strict";return I.apply(this,arguments)};Object.defineProperty(fn,"name",{value:A,configurable:true});return fn}' },
    { kind: 'invoker', start: 'function qA(A,I,g,C,B)', end: 'function bA(', replacement: invoker('qA','JA','h','aA') },
    { kind: 'method', start: 'function kC(A,I)', end: 'function JC(', replacement: method('kC','aC','JA','YC',true) },
  ];
  if (kind === 'opencv') return [
    { kind: 'named', start: 'function createNamedFunction(', end: 'function extendError(', replacement: 'function createNamedFunction(name,body){name=makeLegalFunctionName(name);var fn=function(){"use strict";return body.apply(this,arguments)};Object.defineProperty(fn,"name",{value:name,configurable:true});return fn}' },
    { kind: 'invoker', start: 'function craftInvokerFunction(', end: 'function heap32VectorToArray(', replacement: invoker('craftInvokerFunction','makeLegalFunctionName','throwBindingError','runDestructors') },
    { kind: 'method', start: 'function __emval_get_method_caller(', end: 'function __emval_get_property(', replacement: method('__emval_get_method_caller','__emval_lookupTypes','makeLegalFunctionName','__emval_addMethodCaller',false) },
    { kind: 'dynamic', start: 'function makeDynCaller(', end: 'var fp;', replacement: 'function makeDynCaller(dynCall){var count=signature.length-1;var fn=function(){var args=[rawFunction];for(var i=0;i<count;i++)args.push(arguments[i]);return dynCall.apply(undefined,args)};Object.defineProperties(fn,{name:{value:"dynCall_"+signature+"_"+rawFunction,configurable:true},length:{value:count,configurable:true}});return fn}' },
  ];
  throw Error('Unknown binding artifact');
}
export function patchBindings(kind, source) {
  if (sha256(source) !== sourceHashes[kind]) throw Error(`${kind} source hash mismatch`);
  let result = source;
  for (const patch of bindingPatches(kind)) {
    const start = result.indexOf(patch.start), end = result.indexOf(patch.end, start);
    if (start < 0 || end <= start || end-start > 5000 || result.indexOf(patch.start,start+1)!==-1) throw Error(`Unexpected ${kind} binding boundary`);
    result=result.slice(0,start)+patch.replacement+result.slice(end);
  }
  if (/new Function|new_\(Function|HI\(Function/.test(result)) throw Error('Dynamic execution remains');
  return result;
}
