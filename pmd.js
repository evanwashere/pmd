import kleur from 'npm:kleur';
import { fetch, Agent } from 'npm:undici';

// const HOME = '/home/evan';
const HOME = Deno.env.get('HOME');
const exit = new AbortController();
const k_logs_path = `${HOME}/.config/pmd/logs`;
const k_sock_path = `${HOME}/.config/pmd/pmd.sock`;
const k_config_path = `${HOME}/.config/pmd/pmd.json`;
Deno.addSignalListener('SIGINT', () => exit.abort());
Deno.addSignalListener('SIGTERM', () => exit.abort());
await Deno.mkdir(`${HOME}/.config/pmd/logs`, { recursive: true });
const dispatcher = new Agent({ keepAliveTimeout: 1, connect: { keepAlive: false, socketPath: k_sock_path } });

const [name, ...rest] = Deno.args;

await ({
  [void 0]() {
    throw new Error('unknown command');
  },

  async rm(args) {
    const [query] = args;
    await fetch(`http://localhost/rm`, { dispatcher, method: 'POST', body: JSON.stringify({ query }) });

    return this.list();
  },

  async stop(args) {
    const [query] = args;
    await fetch(`http://localhost/stop`, { dispatcher, method: 'POST', body: JSON.stringify({ query }) });

    return this.list();
  },

  async start(args) {
    const [query] = args;
    await fetch(`http://localhost/start`, { dispatcher, method: 'POST', body: JSON.stringify({ query }) });

    return this.list();
  },

  async env(args) {
    const [name, subcommand, env_name, env_value] = args;

    if (subcommand === 'set') {
      await fetch(`http://localhost/env_set`, { dispatcher, method: 'POST', body: JSON.stringify({ name, env_name, env_value }) });
      return this.list();
    }

    if (['rm', 'unset', 'remove', 'delete'].includes(subcommand)) {
      await fetch(`http://localhost/env_unset`, { dispatcher, method: 'POST', body: JSON.stringify({ name, env_name }) });
      return this.list();
    }

    if (['ls', 'list'].includes(subcommand)) {
      console.table(await (await fetch(`http://localhost/env_list`, { dispatcher, method: 'POST', body: JSON.stringify({ name }) })).json());
      return;
    }

    throw new Error('unknown subcommand');
  },

  async add(args) {
    const [name, bin, ...rest] = args;
    const which = await new Deno.Command('which', { args: [bin] }).output();

    if (!which.success) throw new Error('bin missing in path');

    const cwd = Deno.cwd();
    const path = new TextDecoder().decode(which.stdout).trim();
    await fetch(`http://localhost/add`, { dispatcher, method: 'POST', body: JSON.stringify({ cwd, name, rest, bin: path }) });

    return this.list();
  },

  async list() {
    const list = await (await fetch(`http://localhost/list`, { dispatcher })).json();

    function format(ms) {
      ms /= 1000;
      if (ms < 10) return `${ms.toFixed(3)}s`;
      if (ms < 100) return `${ms.toFixed(2)}s`;
      if (ms < 1000) return `${ms.toFixed(1)}s`; ms /= 60;
      if (ms < 1000) return `${ms.toFixed(1)}m`; ms /= 60;
      if (ms < 1000) return `${ms.toFixed(1)}h`; ms /= 24;
      if (ms < 1000) return `${ms.toFixed(1)}d`; ms /= 7.0;
      if (ms < 1000) return `${ms.toFixed(1)}w`; ms /= 52.143;
      if (ms < 100) return `${ms.toFixed(2)}y`; return `${ms.toFixed(1)}y`;
    }

    console.log(`  ${'name'.padEnd(34)}uptime  restarts`);
    console.log('-'.repeat(52));

    for (const c of list) {
      console.log(
        `${c.enabled ? kleur.green('•') : kleur.red('•')} ${c.name} ${kleur.gray(`(${c.pid})`)}`.padEnd(55)
        + `${kleur.yellow(format(c.uptime))} ${kleur.cyan(`${c.restarts}`).padStart(18)}Ξ `.padStart(38) + kleur.gray(c.bin)
      );

      const names = Object.keys(c.env);
      if (names.length) console.log('└ ' + kleur.gray(names.sort().sort((a, b) => a.length - b.length).join(' ')));
    }
  },

  async service() {
    const processes = new Map;
    let config = JSON.parse(await Deno.readTextFile(k_config_path).catch(() => '[]'));

    async function edit(f) {
      await f(); await Deno.writeTextFile(k_config_path, JSON.stringify(config, null, 2));
    }

    function loop(c) {
      queueMicrotask(async () => {
        let errors = 0;
        let first = true;
        let restarts = -1;

        while ((first || c.enabled) && !exit.signal.aborted) {
          first = false;

          const process = new Deno.Command(c.bin, {
            env: c.env,
            cwd: c.cwd,
            args: c.args,
            stdin: 'null',
            clearEnv: true,
            stdout: 'piped',
            stderr: 'piped',
            signal: exit.signal,
          });

          const child = process.spawn();

          child.up = true;
          child.config = c;
          child.uptime = Date.now();
          child.restarts = ++restarts;
          const stdout = await Deno.open(`${k_logs_path}/${c.name}.log`, { write: true, create: true });
          const stderr = await Deno.open(`${k_logs_path}/${c.name}.err`, { write: true, create: true });

          processes.set(c, child);
          child.stdout.pipeTo(stdout.writable);
          child.stderr.pipeTo(stderr.writable);
          const { code, signal } = await child.status;

          child.up = false;
          if (!c.enabled || exit.signal.aborted) break;
          if (0 === code) errors = 0; else errors = Math.min(6, 1 + errors);

          if (0 === code) continue;
          const backoff = Math.min(1000 * (2 ** errors), 60000);
          await new Promise(ok => child.backoff = { resolve: ok, timeout: setTimeout(ok, backoff) });
        }

        processes.delete(c);
      });
    }

    const server = Deno.serve({
      path: k_sock_path,
      signal: exit.signal,

      onListen({ path }) {
        for (const c of config) if (c.enabled) loop(c);
      },

      async handler(req) {
        const url = new URL(req.url);

        return await ({
          [void 0]() {
            return new Response(null, { status: 404 });
          },

          async start() {
            const { query } = await req.json();
            const c = config.find((c, offset) => query === c.name || (1 + offset) === Number(query));

            if (!c) return new Response(null, { status: 404 });
            if (c.enabled) return new Response(null, { status: 409 });
            c.enabled = true; loop(c); return new Response(null, { status: 204 });
          },

          async stop() {
            const { query } = await req.json();
            const c = config.find((c, offset) => query === c.name || (1 + offset) === Number(query));

            if (!c) return new Response(null, { status: 404 });
            if (!c.enabled) return new Response(null, { status: 404 });
            c.enabled = false; processes.get(c)?.kill(); return new Response(null, { status: 204 });
          },

          async env_set() {
            const { name, env_name, env_value } = await req.json();
            const c = config.find((c, offset) => name === c.name || (1 + offset) === Number(name));

            if (!c) return new Response(null, { status: 404 });
            await edit(() => c.env[env_name] = env_value); return new Response(null, { status: 204 });
          },

          async env_unset() {
            const { name, env_name } = await req.json();
            const c = config.find((c, offset) => name === c.name || (1 + offset) === Number(name));

            if (!c) return new Response(null, { status: 404 });
            await edit(() => delete c.env[env_name]); return new Response(null, { status: 204 });
          },

          async env_list() {
            const { name } = await req.json();
            const c = config.find((c, offset) => name === c.name || (1 + offset) === Number(name));

            if (!c) return new Response(null, { status: 404 });

            return Response.json(c.env);
          },

          async rm() {
            const { query } = await req.json();
            const c = config.find((c, offset) => query === c.name || (1 + offset) === Number(query));

            if (!c) return new Response(null, { status: 404 });

            c.enabled = false;
            processes.get(c)?.kill();
            await edit(() => config = config.filter(o => o !== c));
            try { await Deno.remove(`${k_logs_path}/${c.name}.log`); } catch { }
            try { await Deno.remove(`${k_logs_path}/${c.name}.err`); } catch { }

            return new Response(null, { status: 204 });
          },

          async add() {
            const { cwd, name, rest, bin } = await req.json();
            if (config.some(c => name === c.name)) return new Response(null, { status: 409 });

            const c = {
              cwd,
              bin,
              name,
              env: {},
              args: rest,
              enabled: false,
            };

            await edit(() => config.push(c));
            return new Response(null, { status: 204 });
          },

          list() {
            return Response.json(config.map(c => ({
              env: c.env,
              name: c.name,
              enabled: c.enabled,
              pid: processes.get(c)?.pid || null,
              bin: `${c.bin} ${c.args.join(' ')}`,
              restarts: processes.get(c)?.restarts || null,
              uptime: !processes.get(c) ? null : (Date.now() - processes.get(c).uptime),
            })));
          },
        })[({
          'POST /rm': 'rm',
          'POST /add': 'add',
          'GET /list': 'list',
          'POST /stop': 'stop',
          'POST /start': 'start',
          'POST /env_set': 'env_set',
          'POST /env_list': 'env_list',
          'POST /env_unset': 'env_unset',
        })[`${req.method} ${url.pathname}`]]();
      },
    });

    await server.finished;
    await Deno.remove(k_sock_path);
  },
})[({
  rm: 'rm',
  ls: 'list',
  env: 'env',
  add: 'add',
  new: 'add',
  list: 'list',
  stop: 'stop',
  remove: 'rm',
  delete: 'rm',
  start: 'start',
  status: 'list',
  daemon: 'service',
  service: 'service',
})[name]](rest);