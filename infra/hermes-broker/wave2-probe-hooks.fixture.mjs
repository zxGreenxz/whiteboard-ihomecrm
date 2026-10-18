// Hook nạp module (node:module register) CHỈ cho tiến trình con của test: khi wave2-registry.mjs nạp
// './wave2-a-contract.mjs' thì trả sổ thăm dò. Mã sản phẩm không có đường tiêm nào.
export async function resolve(specifier, context, next) {
  if (specifier === './wave2-a-contract.mjs' && context.parentURL?.endsWith('/wave2-registry.mjs')) return next('./wave2-probe-contract.fixture.mjs', context);
  return next(specifier, context);
}
