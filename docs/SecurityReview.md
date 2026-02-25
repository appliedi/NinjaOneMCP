Here's my full review:

---

## NinjaOne MCP Review: Value for Automated Security Reporting

### The Short Answer

**Yes, there's significant value here** -- but it's a different *kind* of value than what SentinelOne, Huntress, and Umbrella give you. Those three are detection tools. NinjaOne is the **asset inventory and posture management** layer. Without it, your security reports answer *"what happened?"* but not *"to what?"* or *"what's exposed?"*

### What NinjaOne Adds to Your Stack

| Your Current Stack | What It Tells You | What's Missing |
|---|---|---|
| **SentinelOne** | Endpoint detections, threat lifecycle | Which devices *don't* have an agent? Patch state? |
| **Huntress** | Persistent footholds, managed EDR | Asset context, org/location mapping |
| **Umbrella DNS** | Blocked domains, DNS-layer threats | What device made the request? What's installed on it? |
| **NinjaOne (this MCP)** | **Fills all of the above gaps** | *(see gaps below)* |

Specifically, this MCP exposes 60+ tools that give you:

1. **Asset inventory baseline** -- `get_devices`, `query_computer_systems`, `query_operating_systems` -- ties every alert from your other MCPs to a real device with org/location context
2. **Patch posture** -- `query_os_patches`, `query_software_patches`, `query_os_patch_installs` -- "here are all devices missing critical patches" is the single most valuable line in a customer security report
3. **AV coverage & threats** -- `query_antivirus_status`, `query_antivirus_threats` -- cross-reference with SentinelOne to find devices where the AV agent is missing, disabled, or out of date
4. **Software inventory** -- `query_software`, `get_device_software` -- find unauthorized/vulnerable software fleet-wide
5. **Device health** -- `query_device_health` -- offline devices, unhealthy devices, devices not checking in
6. **Backup status** -- `query_backup_usage` -- "are we protected if ransomware hits?"
7. **Multi-tenant org mapping** -- `get_organizations` -- report per-customer, which is critical for MSP security reports

### A Concrete Workflow Example

With all four MCPs, an automated monthly security report per customer could look like:

```
1. NinjaOne: get_organizations → list of customers
2. For each customer:
   a. NinjaOne: get_devices (filtered by org) → device inventory
   b. NinjaOne: query_antivirus_status → AV coverage %
   c. NinjaOne: query_os_patches → missing critical patches
   d. NinjaOne: query_device_health → offline/unhealthy count
   e. NinjaOne: query_backup_usage → backup compliance
   f. SentinelOne: get threats for those device names → detection count
   g. Huntress: get incidents for that org → persistent threats
   h. Umbrella: get blocked requests → DNS-layer blocks
3. Correlate & generate report
```

NinjaOne is the **spine** that connects the other three tools to real assets and real customers.

---

### Code Quality Issues Found

I reviewed every source file. The code is generally well-structured TypeScript, but there are issues you should address before relying on this in production automation:

#### CRITICAL

**1. CORS defaults to wildcard** (`src/transport/http.ts:19,123`)
```typescript
origin: process.env.CORS_ORIGIN || '*'
```
If you ever run this in HTTP/SSE mode (not just stdio), any website can talk to it. For stdio-only MCP use (Claude Desktop, etc.) this is not reachable, but it's a landmine if the deployment model changes.

#### MEDIUM

**2. Duplicate tool definition** (`src/index.ts:149-170`) -- `get_device_software` is defined twice in the TOOLS array. Won't break anything but MCP clients may behave unpredictably with duplicate tool names.

**3. No request timeouts** (`src/ninja-api.ts:109,161`) -- `fetch()` calls have no `AbortController` timeout. A hanging NinjaOne API response will hang your entire MCP server indefinitely. For automated workflows this is a reliability risk.

**4. `set_region` accepts arbitrary URLs** (`src/index.ts:1073`) -- `args.baseUrl` is passed directly to `setBaseUrl()` without validating it's a known NinjaOne domain. An SSRF vector if the MCP is exposed to untrusted input.

```typescript
case 'set_region':
  if (args.baseUrl) this.api.setBaseUrl(args.baseUrl);  // no validation
```

**5. Hardcoded `Access-Control-Allow-Origin: *` in SSE** (`src/transport/http.ts:149`) -- This one bypasses the CORS middleware entirely because it's hardcoded in the `writeHead` call:
```typescript
res.writeHead(200, {
  'Access-Control-Allow-Origin': '*',  // ignores CORS_ORIGIN env var
```

**6. Client-side search fetches 200 devices max** (`src/index.ts:1216,1232`) -- `searchDevicesByName` and `findWindows11Devices` fetch only 200 devices then filter in memory. Customers with more than 200 devices will get incomplete results silently. For security reporting, silent data truncation is dangerous.

**7. Error messages leak infrastructure details** (`src/ninja-api.ts:90`) -- Failed auth lists all attempted regional URLs. Minor, but unnecessary information disclosure.

#### LOW

**8. Version mismatch** -- `package.json` says `1.2.13`, `manifest.json` says `1.2.14`. Not a security issue but indicates release process isn't tight.

**9. Hardcoded maintenance features** (`src/ninja-api.ts:265`) -- `disabledFeatures: ['ALERTS', 'PATCHING', 'AVSCANS', 'TASKS']` is not configurable per-call. Minor flexibility issue.

**10. `get_alerts` ignores device filter** (`src/index.ts:1050`):
```typescript
case 'get_alerts':
  return this.api.getAlerts(undefined, args.since);  // df is hardcoded to undefined
```
The API client accepts a `deviceFilter` param but the tool routing throws it away. You can't filter alerts by device through the MCP.

---

### What's Missing from the NinjaOne API That Would Help

Based on NinjaOne's API capabilities, this MCP does **not** expose:

- **Activities/audit log queries** (`/v2/activities`) -- global activity log, not just per-device. Critical for security audit trails.
- **Ticketing** (`/v2/ticketing/*`) -- if you use NinjaOne ticketing, you could auto-create tickets from security findings.
- **Script execution** (`/v2/device/{id}/script/*`) -- run remediation scripts (e.g., force AV update) as part of the workflow.
- **Device custom fields write** -- you could stamp devices with "last security report date" or "risk score" for dashboard visibility.
- **Group/filter management** -- NinjaOne has saved filters/groups that could map to security report scopes.

---

### Bottom Line

**Use it.** NinjaOne is the asset authority and posture layer your other three MCPs are missing. The code is solid enough for a pilot, but before running automated customer-facing reports, fix the alert device filter bug (#10), the 200-device search cap (#6), and add request timeouts (#3). The CORS issues only matter if you leave stdio transport.

Now let me commit this review and push.