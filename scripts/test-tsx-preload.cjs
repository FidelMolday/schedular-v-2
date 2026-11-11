// tsx currently calls os.userInfo() while registering its loader. In this
// restricted Windows environment that OS lookup can fail before tests start.
const os = require("node:os");
os.userInfo = () => ({ username: "scheduler-test" });
require("node:module").syncBuiltinESMExports();
require("tsx/cjs");

// Runtime authorization tests invoke server entrypoints directly. Keep their
// framework boundary deterministic while leaving the database layer real.
const Module = require("node:module");
const originalLoad = Module._load;
const matrix = (globalThis.__AUTH_MATRIX__ = {
  session: null,
  headerValues: {},
  revalidatedPaths: [],
  redirectTarget: null,
  emailSends: [],
});
Module._load = function (request, parent, isMain) {
  if (request === "@/auth") {
    return { auth: async () => matrix.session, handlers: { GET() {}, POST() {} } };
  }
  if (request === "next/headers") {
    return { headers: async () => new Headers(matrix.headerValues), cookies: async () => new Map() };
  }
  if (request === "next/cache") {
    return { revalidatePath: (path) => matrix.revalidatedPaths.push(path), revalidateTag: () => {} };
  }
  if (request === "next/navigation") {
    return {
      redirect: (target) => { matrix.redirectTarget = target; throw new Error(`NEXT_REDIRECT:${target}`); },
      notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
    };
  }
  if (request === "resend") {
    return { Resend: class { constructor() { this.emails = { send: async (message) => { matrix.emailSends.push(message); return { data: { id: "test-email" }, error: null }; } }; } } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
