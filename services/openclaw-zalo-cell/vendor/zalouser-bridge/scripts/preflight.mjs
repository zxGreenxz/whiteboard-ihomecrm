const match = /^v24\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(process.version);
const userAgent = process.env.npm_config_user_agent ?? "";

if (!match || Number(match[1]) < 15) {
  throw new Error("Official stable Node >=24.15.0 <25 is required");
}
if (!/^npm\/11\.12\.1(?:\s|$)/u.test(userAgent)) {
  throw new Error("npm 11.12.1 is required");
}
