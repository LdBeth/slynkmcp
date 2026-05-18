/**
 * Integration tests against a live SBCL Slynk. Gated on SLYNK_TEST_PORT so
 * plain `deno test` and CI skip them. To run:
 *
 *   sbcl --non-interactive --load scripts/start-test-slynk.lisp &
 *   SLYNK_TEST_PORT=4006 deno test --allow-net --allow-env --allow-read \
 *     --allow-write --config deno.json src/integration_test.ts
 */
import {
  assert,
  assertEquals,
  assertExists,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { Session } from "./session.ts";
import { SlynkClient } from "./slynk/client.ts";
import { sym } from "./slynk/sexp.ts";

const PORT_ENV = Deno.env.get("SLYNK_TEST_PORT");
const PORT = PORT_ENV ? Number(PORT_ENV) : 0;
const ignore = PORT_ENV === undefined;
const HOST = "127.0.0.1";

function newSession(): Session {
  return new Session({ host: HOST, port: PORT, defaultPackage: "CL-USER" });
}

Deno.test({
  name: "SlynkClient: interactive flag marks the originating debugger",
  ignore,
  fn: async () => {
    const client = new SlynkClient({ onDebugActivate: () => {} });
    await client.connect(HOST, PORT);
    try {
      await client.rex([sym("slynk:connection-info")]);
      const marked = client.rex(
        [sym("slynk:interactive-eval"), "(/ 1 0)"],
        { pkg: "CL-USER", interactive: true },
      );
      marked.catch(() => {});
      const plain = client.rex(
        [sym("slynk:interactive-eval"), '(error "plain")'],
        { pkg: "CL-USER" },
      );
      plain.catch(() => {});
      for (let i = 0; i < 150 && client.debugStack.length < 2; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assertEquals(client.debugStack.length, 2);
      assertEquals(client.debugStack.filter((d) => d.interactive).length, 1);
      assertEquals(client.debugStack.filter((d) => !d.interactive).length, 1);
      const interactiveDbg = client.debugStack.find((d) => d.interactive)!;
      assertStringIncludes(interactiveDbg.condition.message, "DIVISION-BY-ZERO");
      // clean up: abort debug levels innermost-first (reverse order)
      for (const d of [...client.debugStack].reverse()) {
        const idx = d.restarts.findIndex((r) => /^abort$/i.test(r.name));
        client.rex(
          [sym("slynk:invoke-nth-restart-for-emacs"), d.level, idx],
          { thread: d.thread },
        ).catch(() => {});
      }
      await Promise.allSettled([marked, plain]);
      for (let i = 0; i < 150 && client.debugStack.length > 0; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assertEquals(client.debugStack.length, 0);
    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "Session.eval: an interactive error suspends in the debugger",
  ignore,
  fn: async () => {
    const session = newSession();
    try {
      const r = await session.eval("(/ 1 0)");
      assertEquals(r.debugEntered, true);
      const d = session.currentDebug();
      assertExists(d);
      assertStringIncludes(d.condition.message, "DIVISION-BY-ZERO");
    } finally {
      await session.stop();
    }
  },
});

Deno.test({
  name: "Session: non-eval errors still auto-abort and leave no debugger behind",
  ignore,
  fn: async () => {
    const session = newSession();
    const file = await Deno.makeTempFile({ suffix: ".lisp" });
    await Deno.writeTextFile(file, '(error "load-time boom")\n');
    try {
      // load-file resolves ("T") even after the debugger is auto-aborted;
      // what matters is that no debugger frame remains on the stack.
      await session.loadFile(file);
      assertEquals(session.currentDebug(), null);
    } finally {
      await session.stop();
      await Deno.remove(file);
    }
  },
});

Deno.test({
  name: "debugInvokeRestart: a CONTINUE restart resumes the suspended eval",
  ignore,
  fn: async () => {
    const session = newSession();
    try {
      const r = await session.eval('(progn (cerror "go on" "stop here") 42)');
      assertEquals(r.debugEntered, true);
      const d = session.currentDebug()!;
      const cont = d.restarts.findIndex((x) => /^continue$/i.test(x.name));
      assert(cont >= 0, "expected a CONTINUE restart");
      const out = await session.debugInvokeRestart(cont);
      assertStringIncludes(out, "42");
      assertEquals(session.currentDebug(), null);
    } finally {
      await session.stop();
    }
  },
});

Deno.test({
  name: "debugAbort: reports the aborted evaluation",
  ignore,
  fn: async () => {
    const session = newSession();
    try {
      await session.eval("(/ 1 0)");
      const out = await session.debugAbort();
      assertStringIncludes(out.toLowerCase(), "abort");
      assertEquals(session.currentDebug(), null);
    } finally {
      await session.stop();
    }
  },
});

Deno.test({
  name: "debugInvokeRestart: a re-erroring restart re-enters the debugger",
  ignore,
  fn: async () => {
    const session = newSession();
    try {
      await session.eval("(/ 1 0)");
      const d = session.currentDebug()!;
      const retry = d.restarts.findIndex((x) => /^retry$/i.test(x.name));
      assert(retry >= 0, "expected a RETRY restart");
      const out = await session.debugInvokeRestart(retry);
      assertStringIncludes(out, "debugger");
      assertExists(session.currentDebug());
      await session.debugAbort();
    } finally {
      await session.stop();
    }
  },
});

Deno.test({
  name: "Session.eval: rejects a second eval while one is suspended",
  ignore,
  fn: async () => {
    const session = newSession();
    try {
      await session.eval("(/ 1 0)");
      await assertRejects(() => session.eval("(+ 1 1)"), Error, "suspended");
      await session.debugAbort();
    } finally {
      await session.stop();
    }
  },
});
