# Cowork managed MCP setup: current implementation and live-test boundary

This work uses canonical MST `servers` / `arms[].servers` and managed third-party
Claude configuration. It is not an Agent SDK substitution or the old AppleScript
driver. The shared configuration/credential code supports macOS and Linux; the
current live-test adapter is macOS-only. A Linux installer is still outstanding.

## Automatic host lifecycle

Select the registered Cowork host and an existing desktop driver. Lifecycle setup
is mandatory for this host; no separate setup flag or manual configure step is
required for a normal suite run:

```json
{
  "host": {
    "type": "cowork",
    "driver": "anthropic.claude.cowork.desktop-app.macos"
  },
  "servers": [
    {
      "transport": "http",
      "label": "search",
      "serverUrl": "https://search.example.test/mcp",
      "auth": { "accessTokenEnv": "SEARCH_MCP_TOKEN" }
    }
  ]
}
```

This is a configuration fragment; the example manifests below also supply a
name and dataset. Replace reserved example URLs with your actual endpoints.
After building MST, a complete example can be run with:

```bash
node dist/cli/index.js run \
  --manifest examples/cowork-setup/single-server.manifest.json \
  --root-dir examples/cowork-setup \
  --secrets-file /absolute/path/to/private.env
```

For `mode: "host"` (or `mcp_host`) cases, MST validates the host configuration,
resolves the selected driver, requires macOS, and prepares the managed profile
before invoking the driver. On other platforms it reports, for example,
`Cowork on linux is not supported yet.` Linux lifecycle support is a TODO. The
existing driver/capability system remains responsible for interaction and traces.
Driver options and capability bindings are accepted using the existing external
host schema. The default trace directory targets the third-party app's
`Claude-3p/local-agent-mode-sessions`, rather than the consumer app's data folder.

- A prepared session is reused across cases, iterations, and datasets within an
  arm, then disposed in `finally`. A serial host/config override disposes the old
  session before acquiring the replacement. Each arm gets a separate session.
- Cowork requires `concurrency: 1`; incompatible concurrency is rejected before
  execution. A profile lease prevents competing runs from stopping the first
  run's app. Only the canonical `~/Library/Application Support/Claude-3p/configLibrary`
  is supported: the fixed app launcher cannot select arbitrary profile folders.
  Alternate profile paths are rejected rather than acquiring a second lease for
  the same application. Do not run other desktop automation against that instance.
- Direct MCP cases and dry runs do not prepare Cowork. Legacy `external_host`
  cases cannot be mixed with a prepared host, since their compatibility path
  bypasses preparation: migrate them to `mode: "host"` and put the driver on
  `host`. The standalone legacy external-host API is otherwise unchanged.
- Credentials come from the suite's explicit runtime context. When a secrets file
  is supplied, Cowork additionally validates its privacy and consistency before
  native setup. Missing credentials, incompatible drivers, unsupported transports,
  conflicting profiles, or unsafe recovery state fail closed.
- The native controller source is embedded in the package and compiled once per
  process on macOS using Xcode Command Line Tools. Runtime does not require the
  repository's shell scripts. The CLI/API does not force-kill Claude or grant OS
  permissions.

Normal failures attempt restoration; cleanup failures are surfaced rather than
reported as success. A hard process termination can retain `.mst-session-lock`
(with a private `session.json` recording prior app state and staging location)
and `.mst-setup-lock` in the configuration library. Do not delete these to retry.
The transaction's file-level recovery must run only after Claude is stopped and
ownership is verified; automatic stale-lock removal is intentionally unsupported.
Manual configure/restore commands below are debugging utilities for their own
manual sessions, not recovery commands for an automatic session lease.

The automatic lifecycle is covered with fake drivers/native controllers and
synthetic credentials. It has not been validated as a complete live Cowork eval;
existing driver readiness issues and independent inventory/tool-policy
verification remain separate limitations. Driver provenance is retained in results.
Native parsing distinguishes MCP server calls from built-in host tools; custom
Cowork drivers must provide explicit tool source/server provenance rather than
rely on server-count inference.

## Implemented

- `src/evals/coworkSetup/config.ts`: exact managed MCP list and allowlist, with
  separate runtime HTTP header resolution. Explicit empty lists are supported.
- `secrets.ts`: private user-owned JSON or dotenv credentials; no interpolation,
  process-environment mutation, symlink following, or secret-bearing errors.
- `bundle.ts`: private ephemeral credential staging and header helpers. Generated
  managed settings and status metadata contain no credential values. Staging is
  **not a shareable artifact**: it does contain private credential files.
- `macTransaction.ts`: creates a separate test configuration in `configLibrary`,
  switches the applied configuration metadata, and supports journaled rollback.
  The original configuration file is never overwritten. This first version
  requires that the originally applied configuration is empty; it rejects
  nonempty profiles rather than copying or changing existing inference secrets.
- `macProfile.ts`: non-secret, read-only profile inspection.
- `macSession.ts`: automatic Mac application/configuration lifecycle, profile
  leasing, partial-prepare rollback, and idempotent disposal.
- `src/evals/coworkHost.ts`: registered Cowork host, driver/platform/configuration
  validation, and native trace adaptation.
- `HostDefinition.prepareSession`: optional generic lifecycle for prepared hosts;
  existing run-only hosts retain their behavior.

The current configuration supports HTTP MCP servers with an explicit label,
HTTPS endpoint (literal loopback HTTP is allowed for local fixtures), static
runtime headers or `auth.accessTokenEnv`. OAuth/client-credentials flows and other
transports are rejected rather than silently ignored. An explicit arm server list,
including `[]`, replaces the manifest-level list.

## Credential contract

The current adapter uses `ANTHROPIC_API_KEY` for Anthropic inference. Each
HTTP MCP server declares its own credentials through `auth.accessTokenEnv` or
supported static headers; unauthenticated servers need no token. Environment
variable names are chosen by the caller, not tied to a particular service.

The manual Mac command currently requires an explicit private JSON/dotenv file
containing the inference key and the referenced MCP credentials. It never searches
for environment files or credential stores. The file must be owned by the current
user, not a symlink, and private (for example, mode 0600). Do not put token values
in manifests, shell arguments, reports, or source control.

MST's suite runner resolves the runtime environment and optional `--secrets-file`.
The automatic Cowork lifecycle passes this context into the adapter; it does not
introduce a second credential source. The manual configure command below remains
available separately for debugging.

Credentials must be valid, scoped for the intended operations, and accepted by the
configured endpoints. The adapter consumes tokens; it does not mint/refresh them
or initiate OAuth consent. Use the relevant service's login flow outside the run
when a token expires, then restore/reconfigure to refresh staged credentials.
Changes to the source environment file are not automatically copied into an active
session. Other inference backends and managed OAuth flows are not implemented.

## Configure and leave open for a manual query

Use the configuration-only workflow when you want to inspect Cowork and type the
query yourself. It **does not submit any prompt or execute the manifest dataset**.
Unlike the smoke command, successful configuration is deliberately left active
until you run `restore`.

From the checkout, in a GUI-enabled macOS terminal:

```bash
bash scripts/cowork-mac-config.sh configure \
  examples/cowork-setup/single-server.manifest.json \
  /absolute/path/to/private.env \
  '/absolute/path/to/Library/Application Support/Claude-3p/configLibrary'
```

The example contains one synthetic server: `https://search.example.test/mcp`,
label `search`, with `auth.accessTokenEnv: SEARCH_MCP_TOKEN`. **The `.example.test`
URLs are non-working placeholders.** Copy the manifest to a local configuration
and replace the URLs with your own MCP endpoints before configuring Cowork. Supply
the referenced tokens and `ANTHROPIC_API_KEY` in the private environment file.
No tokens appear in the example or receipt.

After configuration:

1. Inspect the Cowork composer's connector menu. Confirm `search` (or your chosen
   server label) is connected and is the only enabled external MCP. If you cannot verify the inventory, or an extra
   MCP is enabled, do not infer exclusivity from the generated allowlist alone.
2. You may then manually ask **“Find documents about onboarding.”**, or another
   read-only query supported by your server. The reference dataset contains that
   text but the configuration command never executes it.
3. Inspect the response's tool activity. Cowork's built-in host tools are distinct
   from MCP servers; the script has not independently inspected the runtime
   inventory or collected native query telemetry.
4. Finish with the explicit restore command:

```bash
bash scripts/cowork-mac-config.sh restore \
  '/absolute/path/to/Library/Application Support/Claude-3p/configLibrary'
```

The command restores the prior applied configuration and app-running state,
removes private token staging, and does not delete query/session history. It
rejects another setup while its session/lock remains active. Do not edit the
Developer configuration, delete the recovery lock, or remove private staging
while using the test profile. Interrupted or failed configuration attempts retain
recovery information when safe cleanup cannot be proven.

A non-secret receipt in `.mcp-test-results/cowork-setup/` records the exact server
URLs/names, configured allowlist, and `restorationPending: true`.
`completeInventoryVerified: false` is intentional: a successful configure command
is not a claim that independent Desktop inventory verification has passed.

### Optional write-tool preapproval

Authentication and tool approval are separate. To preapprove **all tools** on the
configured MCP servers, including tools that write/delete data, add this top-level
block to the canonical manifest:

```json
"coworkSetup": { "approveWriteTools": true }
```

- Unset or `false`: preserve Cowork's existing approval behavior. No `toolPolicy`
  is emitted; this does not revoke previously saved user approvals, enforce
  read-only execution, or classify tools by their names/annotations.
- `true`: each selected managed MCP entry gets `"toolPolicy": { "*": "allow" }`.
  This applies to present **and future tools** on those servers, including generic
  action-dispatch tools. Native built-in shell/filesystem permissions and network
  controls are unchanged. There is no global permission-bypass switch.
- `arms[].coworkSetup` inherits the manifest setting; an explicit
  `approveWriteTools: false` cancels the parent opt-in. Only the selected arm's
  server list receives the resulting policy. The manual Mac CLI uses the base
  manifest; arm selection is available through the programmatic bundle/installer.

An explicit opt-in example is
`examples/cowork-setup/multi-server-approve-writes.manifest.json`. The default
multi-server example leaves the existing approval behavior unchanged. Restore the active configuration first,
then use the opt-in example in the same configure command. Do not edit the active
managed profile in place: the recovery journal protects its exact contents.

The [native configuration reference](https://claude.com/docs/third-party/claude-desktop/configuration)
documents per-server `toolPolicy`, including `*` wildcards and `allow` preapproval.
This targets Cowork, not Claude Code (which does not forward `allow` rules through
the same path). Authentication, organization restrictions, and mandatory native
confirmations can still apply. Test your installed Cowork version before assuming
all approval popups are gone; we do not click or bypass remaining prompts.

Setup **does not invoke any tools or execute the dataset**, even with this option.
The receipt records each server's intended policy and `toolPolicyVerified: false`.
Native policy behavior still requires a GUI check; no write is needed just to
inspect the tool-permissions UI. Enabling permissions does not authorize a test
runner to perform arbitrary writes. Prefer isolated accounts for write-enabled
testing, and explicitly request each consequential action you intend to test.

### Restore diagnostics and formatting changes

Claude may reserialize `_meta.json` without changing its data (for example,
removing the final newline). Recovery accepts whitespace-only differences outside
JSON strings. It still rejects changed selections, entry names, extra fields,
duplicate keys, and changes to the profile or credential staging. The final file
replacement continues to compare the exact bytes just observed before writing.

The configuration command reports a sanitized failing phase, such as
`restore-files`, without printing raw errors or credentials. For a read-only
comparison of the saved recovery state:

```bash
node scripts/cowork-restore-diagnose.mjs \
  '/absolute/path/to/Library/Application Support/Claude-3p/configLibrary'
```

The diagnostic emits booleans and counts, not credential values or hashes. Do not
delete a lock or staging directory to work around a failed restore.

## Multiple external MCPs

The configuration core and manual configure command use the full `servers` array;
there is no one-server limit. Tests cover 0, 2, and 6 servers, distinct credentials,
exact allowlists, and replacement/cleanup. This does not mean every transport or
authentication mechanism is supported: the HTTP/static-header/bearer restrictions
above still apply.

For a two-server template, use
`examples/cowork-setup/multi-server.manifest.json`. It contains:

- `search`: `https://search.example.test/mcp`, using `SEARCH_MCP_TOKEN`.
- `calendar`: `https://calendar.example.test/mcp`, using `CALENDAR_MCP_TOKEN`.

Replace these reserved example URLs before use. Both credentials come from the
same private environment file, but each helper receives only its server's headers.
The adapter connects directly to the configured endpoints; it does not intercept
writes. Use read-only queries unless you explicitly intend to test write behavior.

Restore an existing manual configuration before configuring the two-server
manifest. The original session remains protected by its lock until restoration;
a second configure command will not silently replace it.

A direct SDK preflight can check endpoint authentication with `initialize` and
`tools/list`, without invoking tools. If a server rejects the token, renew it
outside the run and repeat the preflight. A successful preflight is not proof of
Cowork's active inventory; confirm the intended servers in Cowork's connector menu.
Asking the model which servers it has is not independent inventory proof.

`scripts/cowork-mcp-preflight.mjs` supports read-only protocol checks of every
manifest-level server, with no `tools/call` or query submission. It requires the
compiled setup directory as its third argument and emits sanitized counts/statuses
rather than tool contents or credential values. The Mac configure command itself
still does not prove native connection success.

## Mac setup-only smoke command

After `npm ci`, run from a macOS **GUI-enabled, authorized execution context**:

```bash
bash scripts/run-cowork-mac-smoke.sh \
  /absolute/path/to/private.env \
  '/absolute/path/to/Library/Application Support/Claude-3p/configLibrary'
```

The environment file must be a private regular file owned by the current user
(e.g. mode 0600) and contain `ANTHROPIC_API_KEY`. Token values must not be passed on
the command line or pasted into a chat. MCP authentication in this first smoke is
provided by a temporary per-run token against a loopback test server, not a
workplace MCP endpoint.

The smoke:

1. Checks that native AppKit can observe the GUI session and Claude's bundle.
2. Gracefully stops Claude if necessary. It never force-kills an app or grants OS
   permissions. Do not interact with Claude while the test owns its configuration.
3. Stages a separate managed test configuration with a private inference helper
   and authenticated test MCP. The original applied profile must be empty.
4. Launches Claude using native AppKit/Launch Services, not AppleScript.
5. Waits at most 120 seconds for authenticated MCP `initialize` and `tools/list`
   requests from an external client. The runner itself does not act as an MCP
   client, submit a prompt, or invoke a model query.
6. Stops the test app, restores the original metadata, removes its private staging,
   and restores the original app-running state if observable.

On cancellation, normal failure, or timeout, cleanup is attempted. If app shutdown,
metadata comparison, or ownership checks fail, the recovery journal and private
staging may remain. Never bypass that lock or delete it merely to rerun. The
exported `restoreMacCoworkSettings()` function provides file-level recovery; the
caller must first ensure Claude is stopped. Unexpected metadata/profile edits
are not overwritten by recovery.

Private staging is under ignored `.cowork-runtime/`, not in the shareable results
folder. Sanitized results are written to `.mcp-test-results/cowork-setup/`.

## What a smoke result does and does not prove

- A generated bundle is **not** evidence that Claude applied it.
- On-disk installation/restoration is **not** a successful Desktop connection.
- Authenticated fixture requests are useful live integration evidence, but do
  not independently prove the complete enabled connector/plugin inventory.
- `completeInventoryVerified` remains false in this implementation, and the smoke
  exits nonzero until that final gate is implemented and satisfied. Do not label
  a partial connection result as complete end-to-end setup success.
- The smoke uses no computer use to apply configuration or launch Claude. Complete
  runtime inventory inspection may still need an authorized desktop-observation
  interface. Accessibility permissions are never requested or changed by it.

## Runtime prerequisites

Valid credentials alone are not enough to run a desktop host. The Mac adapter
requires an installed Claude Desktop bundle, a visible GUI session, a writable
user-owned configuration library with an empty original profile, and no conflicting
managed preferences. It rejects an invisible GUI context before profile mutation
rather than treating it as proof that Claude is closed. Missing GUI access is not
an authentication failure. Linux application lifecycle support remains a TODO.

Cleanup after a failed launch does not prove that Cowork connected successfully.
Keep installation, authentication preflight, native connection evidence, and
complete inventory verification separate in reports.

## Sources

- [Managed MCP extensibility](https://claude.com/docs/third-party/claude-desktop/extensions)
- [Local configuration and managed precedence](https://claude.com/docs/third-party/claude-desktop/mdm)
- [Inference credential helpers](https://claude.com/docs/third-party/claude-desktop/configuration)
