import type { AuditEvent, AuditStatus } from "@agent-native/core/audit";
import {
  useActionMutation,
  useActionQuery,
} from "@agent-native/core/client/hooks";
import { useOrgRole } from "@agent-native/core/client/org";
import {
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconEdit,
  IconEye,
  IconEyeOff,
  IconKey,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { ActionQueryError } from "../../components/action-query-error";
import { DispatchShell } from "../../components/dispatch-shell";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../../components/ui/alert-dialog";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import { Switch } from "../../components/ui/switch";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../../components/ui/tabs";
import { Textarea } from "../../components/ui/textarea";

const PROVIDERS = [
  "google",
  "slack",
  "sendgrid",
  "github",
  "stripe",
  "hubspot",
  "jira",
  "bigquery",
  "anthropic",
  "other",
];
const PROVIDER_NONE_VALUE = "__none__";

type VaultAccessMode = "all-apps" | "manual";

const AUDIT_ANY_VALUE = "__any__";
const AUDIT_PAGE_SIZE = 25;
const AUDIT_TIME_RANGES: Array<{ value: string; label: string; ms: number }> = [
  { value: "1h", label: "Last hour", ms: 60 * 60 * 1000 },
  { value: "24h", label: "Last 24 hours", ms: 24 * 60 * 60 * 1000 },
  { value: "7d", label: "Last 7 days", ms: 7 * 24 * 60 * 60 * 1000 },
  { value: "30d", label: "Last 30 days", ms: 30 * 24 * 60 * 60 * 1000 },
];

/** One page of `list-vault-audit`, mirroring the action's return shape. */
type VaultAuditPage = {
  events: AuditEvent[];
  limit: number;
  offset: number;
  hasMore: boolean;
};

export function meta() {
  return [{ title: "Vault — Dispatch" }];
}

function AddSecretDialog() {
  const [open, setOpen] = useState(false);
  const [credentialKey, setCredentialKey] = useState("");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [provider, setProvider] = useState("");
  const [description, setDescription] = useState("");

  const create = useActionMutation("create-vault-secret", {
    onSuccess: () => {
      toast.success("Secret created");
      setOpen(false);
      setCredentialKey("");
      setName("");
      setValue("");
      setProvider("");
      setDescription("");
    },
    onError: (err) => toast.error(String(err)),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <IconPlus size={16} className="mr-1.5" />
          Add secret
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add vault secret</DialogTitle>
          <DialogDescription>
            Store a credential that can be granted to workspace apps.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>Name</Label>
            <Input
              placeholder="Google OAuth Client ID"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Credential key (env var name)</Label>
            <Input
              placeholder="GOOGLE_CLIENT_ID"
              value={credentialKey}
              onChange={(e) => setCredentialKey(e.target.value)}
              className="font-mono text-sm"
            />
          </div>
          <div className="space-y-2">
            <Label>Value</Label>
            <Input
              type="password"
              placeholder="The secret value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Provider</Label>
            <Select value={provider} onValueChange={setProvider}>
              <SelectTrigger>
                <SelectValue placeholder="Select a provider..." />
              </SelectTrigger>
              <SelectContent>
                {PROVIDERS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p.charAt(0).toUpperCase() + p.slice(1)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Description (optional)</Label>
            <Textarea
              placeholder="What is this secret used for?"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={() =>
              create.mutate({
                credentialKey,
                name,
                value,
                provider: provider || undefined,
                description: description || undefined,
              })
            }
            disabled={!credentialKey || !name || !value || create.isPending}
          >
            {create.isPending ? "Creating..." : "Create secret"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditSecretDialog({ secret }: { secret: any }) {
  const [open, setOpen] = useState(false);
  const [credentialKey, setCredentialKey] = useState(
    secret.credentialKey || "",
  );
  const [name, setName] = useState(secret.name || "");
  // Never prefilled. The dialog has no value to prefill with, and giving it
  // one would make every edit a reveal that nothing recorded.
  const [value, setValue] = useState("");
  const [provider, setProvider] = useState(secret.provider || "");
  const [description, setDescription] = useState(secret.description || "");
  const [showValue, setShowValue] = useState(false);

  const update = useActionMutation("update-vault-secret", {
    onSuccess: () => {
      toast.success("Secret updated");
      setOpen(false);
      setShowValue(false);
    },
    onError: (err) => toast.error(String(err)),
  });

  const resetDraft = () => {
    setCredentialKey(secret.credentialKey || "");
    setName(secret.name || "");
    setValue("");
    setProvider(secret.provider || "");
    setDescription(secret.description || "");
    setShowValue(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) resetDraft();
        setOpen(nextOpen);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <IconEdit size={14} className="mr-1" />
          Edit secret
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit vault secret</DialogTitle>
          <DialogDescription>
            Update the stored key and metadata. Changes sync to the shared
            credential store.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4 py-2"
          onSubmit={(event) => {
            event.preventDefault();
            update.mutate({
              id: secret.id,
              credentialKey,
              name,
              // Omitted rather than sent empty: an untouched field must leave
              // the stored value alone, not overwrite it with a blank.
              ...(value ? { value } : {}),
              provider: provider || null,
              description: description || null,
            });
          }}
        >
          <div className="space-y-2">
            <Label htmlFor={`vault-secret-name-${secret.id}`}>Name</Label>
            <Input
              id={`vault-secret-name-${secret.id}`}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`vault-secret-key-${secret.id}`}>
              Credential key (env var name)
            </Label>
            <Input
              id={`vault-secret-key-${secret.id}`}
              value={credentialKey}
              onChange={(e) => setCredentialKey(e.target.value)}
              className="font-mono text-sm"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`vault-secret-value-${secret.id}`}>Value</Label>
            <div className="flex gap-2">
              <Input
                id={`vault-secret-value-${secret.id}`}
                type={showValue ? "text" : "password"}
                placeholder="Leave blank to keep the current value"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className="font-mono text-sm"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => setShowValue((current) => !current)}
                aria-label={
                  showValue ? "Hide secret value" : "Show secret value"
                }
              >
                {showValue ? <IconEyeOff size={15} /> : <IconEye size={15} />}
              </Button>
            </div>
          </div>
          <div className="space-y-2">
            <Label>Provider</Label>
            <Select
              value={provider || PROVIDER_NONE_VALUE}
              onValueChange={(nextProvider) =>
                setProvider(
                  nextProvider === PROVIDER_NONE_VALUE ? "" : nextProvider,
                )
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a provider..." />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={PROVIDER_NONE_VALUE}>No provider</SelectItem>
                {PROVIDERS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p.charAt(0).toUpperCase() + p.slice(1)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`vault-secret-description-${secret.id}`}>
              Description
            </Label>
            <Textarea
              id={`vault-secret-description-${secret.id}`}
              placeholder="What is this secret used for?"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                !credentialKey.trim() || !name.trim() || update.isPending
              }
            >
              {update.isPending ? "Saving..." : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function GrantDialog({
  secretId,
  secretName,
}: {
  secretId: string;
  secretName: string;
}) {
  const [open, setOpen] = useState(false);
  const [appId, setAppId] = useState("");
  const { data: catalog } = useActionQuery("list-integrations-catalog", {});

  const grant = useActionMutation("create-vault-grant", {
    onSuccess: () => {
      toast.success(`Granted to ${appId}`);
      setOpen(false);
      setAppId("");
    },
    onError: (err) => toast.error(String(err)),
  });

  const apps = (catalog || []).map((a: any) => ({
    id: a.appId,
    name: a.appName,
  }));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <IconPlus size={14} className="mr-1" />
          Grant
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Grant "{secretName}" to an app</DialogTitle>
          <DialogDescription>
            Choose which app should receive this secret.
          </DialogDescription>
        </DialogHeader>
        <div className="py-2">
          <Select value={appId} onValueChange={setAppId}>
            <SelectTrigger>
              <SelectValue placeholder="Select an app..." />
            </SelectTrigger>
            <SelectContent>
              {apps.map((app: any) => (
                <SelectItem key={app.id} value={app.id}>
                  {app.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button
            onClick={() => grant.mutate({ secretId, appId })}
            disabled={!appId || grant.isPending}
          >
            {grant.isPending ? "Granting..." : "Grant access"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VaultAccessSettingsCard({ mode }: { mode: VaultAccessMode }) {
  const update = useActionMutation("set-vault-access-settings", {
    onSuccess: (next: any) =>
      toast.success(
        next?.mode === "manual"
          ? "Manual vault access enabled"
          : "All apps can use vault keys",
      ),
    onError: (err) => toast.error(String(err)),
  });
  const allApps = mode !== "manual";

  return (
    <div className="rounded-xl bg-card px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <Label className="text-sm font-medium">
            All apps can use vault keys
          </Label>
          <p className="mt-1 text-xs text-muted-foreground">
            {allApps
              ? "Every workspace app can receive every saved key."
              : "Only apps with explicit grants can receive saved keys."}
          </p>
        </div>
        <Switch
          checked={allApps}
          disabled={update.isPending}
          onCheckedChange={(checked) =>
            update.mutate({ mode: checked ? "all-apps" : "manual" })
          }
          aria-label="Allow all workspace apps to use vault keys"
        />
      </div>
    </div>
  );
}

function SecretRow({
  secret,
  grants,
  accessMode,
}: {
  secret: any;
  grants: any[];
  accessMode: VaultAccessMode;
}) {
  const [expanded, setExpanded] = useState(false);
  // The value is not in the list payload, so it is not in the page until
  // someone clicks the eye — and clicking it writes an audit row.
  const [revealedValue, setRevealedValue] = useState<string | null>(null);

  const reveal = useActionMutation("reveal-vault-secret", {
    onSuccess: (data: any) => setRevealedValue(data.value),
    onError: (err) => toast.error(String(err)),
  });

  const deleteSecret = useActionMutation("delete-vault-secret", {
    onSuccess: () => toast.success("Secret deleted"),
    onError: (err) => toast.error(String(err)),
  });
  const revokeGrant = useActionMutation("revoke-vault-grant", {
    onSuccess: () => toast.success("Grant revoked"),
    onError: (err) => toast.error(String(err)),
  });
  const syncToApp = useActionMutation("sync-vault-to-app", {
    onSuccess: (data: any) =>
      toast.success(`Synced ${data.synced} key(s) to ${data.appId}`),
    onError: (err) => toast.error(String(err)),
  });

  const activeGrants = grants.filter((g) => g.status === "active");
  const allApps = accessMode !== "manual";

  return (
    <div className="rounded-xl bg-card">
      <button
        type="button"
        className="flex w-full items-center gap-3 px-4 py-3 text-left cursor-pointer"
        onClick={() => {
          if (expanded) setRevealedValue(null);
          setExpanded(!expanded);
        }}
      >
        {expanded ? (
          <IconChevronDown size={16} className="text-muted-foreground" />
        ) : (
          <IconChevronRight size={16} className="text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">
              {secret.name}
            </span>
            {secret.provider && (
              <Badge variant="secondary" className="text-xs">
                {secret.provider}
              </Badge>
            )}
          </div>
          <div className="mt-0.5 font-mono text-xs text-muted-foreground">
            {secret.credentialKey}
            {/* The preview lives here too: telling six OPENAI_API_KEY-ish
                rows apart should not cost six expands. */}
            {secret.last4 ? ` · ${secret.last4}` : ""}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-xs">
            {allApps
              ? "All apps"
              : `${activeGrants.length} grant${activeGrants.length !== 1 ? "s" : ""}`}
          </Badge>
        </div>
      </button>

      {expanded && (
        <div className="border-t px-4 py-3 space-y-3">
          {secret.description && (
            <p className="text-sm text-muted-foreground">
              {secret.description}
            </p>
          )}

          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Value:</span>
            <code className="text-xs font-mono text-foreground">
              {/* "" is a row with nothing stored; a missing field is a list
                  payload that could not say either way. They are not the
                  same answer, so they do not render as the same sentence. */}
              {revealedValue ??
                (typeof secret.last4 === "string"
                  ? secret.last4 || "No value stored"
                  : "Preview unavailable")}
            </code>
            <button
              type="button"
              disabled={reveal.isPending}
              onClick={() =>
                revealedValue !== null
                  ? setRevealedValue(null)
                  : reveal.mutate({ id: secret.id })
              }
              className="text-muted-foreground hover:text-foreground cursor-pointer"
              aria-label={
                revealedValue !== null
                  ? "Hide secret value"
                  : "Reveal secret value"
              }
            >
              {revealedValue !== null ? (
                <IconEyeOff size={14} />
              ) : (
                <IconEye size={14} />
              )}
            </button>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-foreground">
                {allApps ? "Access" : "Grants"}
              </span>
              {!allApps && (
                <GrantDialog secretId={secret.id} secretName={secret.name} />
              )}
            </div>
            {allApps ? (
              <div className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
                Available to every workspace app.
              </div>
            ) : activeGrants.length > 0 ? (
              <div className="space-y-1.5">
                {activeGrants.map((grant: any) => (
                  <div
                    key={grant.id}
                    className="flex items-center justify-between rounded-lg border px-3 py-2"
                  >
                    <div>
                      <span className="text-sm font-medium text-foreground">
                        {grant.appId}
                      </span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {grant.syncedAt
                          ? `synced ${new Date(grant.syncedAt).toLocaleString()}`
                          : "not synced"}
                      </span>
                    </div>
                    <div className="flex gap-1.5">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => syncToApp.mutate({ appId: grant.appId })}
                        disabled={syncToApp.isPending}
                      >
                        <IconRefresh size={14} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          revokeGrant.mutate({ grantId: grant.id })
                        }
                        disabled={revokeGrant.isPending}
                      >
                        <IconX size={14} />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
                No grants yet.
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 border-t pt-3">
            <EditSecretDialog secret={secret} />
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={deleteSecret.isPending}
                >
                  <IconTrash size={14} className="mr-1" />
                  Delete secret
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete this secret?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Removing “{secret.name}” revokes all of its grants. Apps
                    that depended on this credential can lose access on the next
                    sync. This cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => deleteSecret.mutate({ id: secret.id })}
                  >
                    Delete secret
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      )}
    </div>
  );
}

function RequestRow({
  request,
  canManage,
}: {
  request: any;
  canManage: boolean;
}) {
  const [secretValue, setSecretValue] = useState("");

  const approve = useActionMutation("approve-vault-request", {
    onSuccess: () => {
      toast.success("Request approved");
      setSecretValue("");
    },
    onError: (err) => toast.error(String(err)),
  });
  const deny = useActionMutation("deny-vault-request", {
    onSuccess: () => toast.success("Request denied"),
    onError: (err) => toast.error(String(err)),
  });

  return (
    <div className="rounded-xl border bg-muted/30 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-foreground">
            <span className="font-mono">{request.credentialKey}</span> for{" "}
            <span className="font-semibold">{request.appId}</span>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            Requested by {request.requestedBy}
            {request.reason && ` — "${request.reason}"`}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {request.status === "pending"
              ? "Pending"
              : request.status === "approved"
                ? `Approved by ${request.reviewedBy}`
                : `Denied by ${request.reviewedBy}`}{" "}
            · {new Date(request.createdAt).toLocaleString()}
          </div>
        </div>
        {request.status === "pending" && (
          <Badge variant="outline" className="whitespace-nowrap">
            Pending
          </Badge>
        )}
        {request.status === "approved" && (
          <Badge
            variant="secondary"
            className="whitespace-nowrap bg-green-500/10 text-green-700 dark:text-green-400"
          >
            Approved
          </Badge>
        )}
        {request.status === "denied" && (
          <Badge
            variant="secondary"
            className="whitespace-nowrap bg-red-500/10 text-red-700 dark:text-red-400"
          >
            Denied
          </Badge>
        )}
      </div>
      {request.status === "pending" && canManage ? (
        <div className="mt-3 flex items-end gap-2 border-t pt-3">
          <div className="flex-1 space-y-1">
            <Label className="text-xs">Secret value to provision</Label>
            <Input
              type="password"
              placeholder="Enter the secret value"
              value={secretValue}
              onChange={(e) => setSecretValue(e.target.value)}
              className="h-8 text-sm"
            />
          </div>
          <Button
            size="sm"
            onClick={() => approve.mutate({ id: request.id, secretValue })}
            disabled={!secretValue || approve.isPending}
          >
            Approve
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => deny.mutate({ id: request.id })}
            disabled={deny.isPending}
          >
            Deny
          </Button>
        </div>
      ) : request.status === "pending" ? (
        <p className="mt-3 border-t pt-3 text-xs text-muted-foreground">
          Waiting for a workspace owner or admin to review this request.
        </p>
      ) : null}
    </div>
  );
}

const AUDIT_STATUS_LABELS: Record<AuditStatus, string> = {
  success: "Success",
  denied: "Denied",
  error: "Error",
};

function AuditStatusBadge({
  status,
  errorCode,
}: {
  status: AuditStatus;
  errorCode?: string | null;
}) {
  if (status === "success") {
    return <Badge variant="secondary">Success</Badge>;
  }
  // An unrecognized status shows itself rather than being relabelled "Error":
  // a reader must be able to tell a refusal we know about from one we don't.
  return (
    <Badge variant="destructive">
      {AUDIT_STATUS_LABELS[status] ?? status}
      {errorCode ? ` · ${errorCode}` : ""}
    </Badge>
  );
}

/**
 * Vault activity, read from the framework action audit log rather than
 * `vault_audit_log`: a refused read throws inside the vault store before it
 * could write a vault-log row, so only the action seam records the refusal.
 * The list surface omits each event's recorded input, so browsing the timeline
 * never streams key names or payloads in bulk.
 */
function VaultAuditTab() {
  const [actionFilter, setActionFilter] = useState("");
  const [actorFilter, setActorFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState(AUDIT_ANY_VALUE);
  const [rangeFilter, setRangeFilter] = useState(AUDIT_ANY_VALUE);
  const [offset, setOffset] = useState(0);

  const rangeMs = AUDIT_TIME_RANGES.find((r) => r.value === rangeFilter)?.ms;
  // Anchored to the moment the range changed. Recomputing `Date.now()` on every
  // render would hand the query a new key each pass and refetch forever.
  const sinceMs = useMemo(
    () => (rangeMs === undefined ? undefined : Date.now() - rangeMs),
    [rangeMs],
  );

  const auditQuery = useActionQuery("list-vault-audit", {
    limit: AUDIT_PAGE_SIZE,
    offset,
    ...(actionFilter.trim() ? { action: actionFilter.trim() } : {}),
    ...(actorFilter.trim() ? { actorEmail: actorFilter.trim() } : {}),
    ...(statusFilter === AUDIT_ANY_VALUE ? {} : { status: statusFilter }),
    ...(sinceMs === undefined ? {} : { sinceMs }),
  });
  const page = auditQuery.data as VaultAuditPage | undefined;
  // A page that arrives without an `events` array is a broken response, not an
  // empty timeline — say so instead of rendering "no vault activity yet" over
  // a trail we failed to read.
  const malformed = page !== undefined && !Array.isArray(page.events);
  const events = malformed ? [] : (page?.events ?? []);

  return (
    <div className="space-y-3">
      {auditQuery.isError ? (
        <ActionQueryError
          error={auditQuery.error}
          onRetry={() => void auditQuery.refetch()}
        />
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={actionFilter}
          onChange={(e) => {
            setActionFilter(e.target.value);
            setOffset(0);
          }}
          placeholder="Action, e.g. sync-vault-to-app"
          className="h-8 w-56 text-sm"
        />
        <Input
          value={actorFilter}
          onChange={(e) => {
            setActorFilter(e.target.value);
            setOffset(0);
          }}
          placeholder="Actor email"
          className="h-8 w-56 text-sm"
        />
        <Select
          value={statusFilter}
          onValueChange={(value) => {
            setStatusFilter(value);
            setOffset(0);
          }}
        >
          <SelectTrigger className="h-8 w-36 text-sm">
            <SelectValue placeholder="Any outcome" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={AUDIT_ANY_VALUE}>Any outcome</SelectItem>
            <SelectItem value="success">Success</SelectItem>
            <SelectItem value="denied">Denied</SelectItem>
            <SelectItem value="error">Error</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={rangeFilter}
          onValueChange={(value) => {
            setRangeFilter(value);
            setOffset(0);
          }}
        >
          <SelectTrigger className="h-8 w-40 text-sm">
            <SelectValue placeholder="Any time" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={AUDIT_ANY_VALUE}>Any time</SelectItem>
            {AUDIT_TIME_RANGES.map((range) => (
              <SelectItem key={range.value} value={range.value}>
                {range.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {events.map((event) => (
        <div key={event.id} className="rounded-xl border bg-muted/30 px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="text-sm font-medium text-foreground">
              {event.summary || event.action}
            </div>
            <AuditStatusBadge
              status={event.status}
              errorCode={event.errorCode}
            />
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {event.actorEmail || "system"}
            {event.actorKind === "agent" ? " (agent)" : ""} ·{" "}
            {new Date(event.createdAt).toLocaleString()}
            {event.targetType ? ` · ${event.targetType}` : ""}
            {event.targetId ? ` ${event.targetId}` : ""}
          </div>
        </div>
      ))}

      {!auditQuery.isError && auditQuery.isLoading && (
        <div className="rounded-xl border px-4 py-3 space-y-2">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      )}

      {malformed && (
        <div className="rounded-2xl border border-dashed px-6 py-12 text-center text-sm text-muted-foreground">
          Vault activity could not be read. Reload to try again.
        </div>
      )}

      {!auditQuery.isError &&
        !auditQuery.isLoading &&
        !malformed &&
        events.length === 0 && (
          <div className="rounded-2xl border border-dashed px-6 py-12 text-center text-sm text-muted-foreground">
            {offset > 0
              ? "No vault activity on this page."
              : "No vault activity yet."}
          </div>
        )}

      {(offset > 0 || page?.hasMore) && (
        <div className="flex items-center justify-between pt-1">
          <span className="text-xs text-muted-foreground">
            {`Events ${offset + 1}–${offset + events.length}`}
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - AUDIT_PAGE_SIZE))}
            >
              <IconChevronLeft size={16} />
              Previous
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!page?.hasMore}
              onClick={() => setOffset(offset + AUDIT_PAGE_SIZE)}
            >
              Next
              <IconChevronRight size={16} />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function VaultRoute() {
  const { org, role, isLoading: orgLoading, error: orgError } = useOrgRole();
  const accessReady = !orgLoading && !orgError && !!org;
  const canManageVault =
    accessReady && (!org.orgId || role === "owner" || role === "admin");
  const secretsQuery = useActionQuery(
    "list-vault-secrets",
    {},
    { enabled: canManageVault },
  );
  const grantsQuery = useActionQuery(
    "list-vault-grants",
    {},
    { enabled: canManageVault },
  );
  const requestsQuery = useActionQuery(
    "list-vault-requests",
    {},
    { enabled: accessReady },
  );
  const accessQuery = useActionQuery(
    "get-vault-access-settings",
    {},
    { enabled: accessReady },
  );
  const { data: secrets, isLoading: secretsLoading } = secretsQuery;
  const { data: grants } = grantsQuery;
  const { data: requests } = requestsQuery;
  const { data: accessSettings } = accessQuery;
  const accessMode: VaultAccessMode =
    (accessSettings as any)?.mode === "manual" ? "manual" : "all-apps";

  const grantsBySecret = (grants || []).reduce(
    (acc: Record<string, any[]>, g: any) => {
      if (!acc[g.secretId]) acc[g.secretId] = [];
      acc[g.secretId].push(g);
      return acc;
    },
    {} as Record<string, any[]>,
  );

  const pendingRequests = (requests || []).filter(
    (r: any) => r.status === "pending",
  );

  return (
    <DispatchShell
      title="Vault"
      description="Centralized secret management for your workspace. Store credentials once and sync them to apps."
    >
      <Tabs defaultValue="secrets">
        <TabsList>
          <TabsTrigger value="secrets">
            Secrets {(secrets?.length || 0) > 0 && `(${secrets?.length})`}
          </TabsTrigger>
          <TabsTrigger value="requests">
            Requests{" "}
            {pendingRequests.length > 0 && (
              <Badge
                variant="secondary"
                className="ml-1.5 h-5 px-1.5 text-xs bg-amber-500/10 text-amber-700 dark:text-amber-400"
              >
                {pendingRequests.length}
              </Badge>
            )}
          </TabsTrigger>
          {canManageVault ? (
            <TabsTrigger value="audit">Audit</TabsTrigger>
          ) : null}
        </TabsList>

        <TabsContent value="secrets" className="mt-4 space-y-3">
          {!accessReady ? (
            <div className="rounded-2xl border border-dashed px-6 py-12 text-center text-sm text-muted-foreground">
              Checking workspace access…
            </div>
          ) : !canManageVault ? (
            <div className="rounded-2xl border border-dashed px-6 py-12 text-center">
              <IconKey size={32} className="mx-auto text-muted-foreground/50" />
              <h3 className="mt-3 text-sm font-medium text-foreground">
                Vault management is restricted
              </h3>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                Workspace owners and admins manage shared secret values. Use a
                request from the app that needs a key, and an admin can review
                it from the Requests tab.
              </p>
            </div>
          ) : secretsQuery.isError ||
            grantsQuery.isError ||
            accessQuery.isError ? (
            <ActionQueryError
              error={
                secretsQuery.error ?? grantsQuery.error ?? accessQuery.error
              }
              onRetry={() => {
                void secretsQuery.refetch();
                void grantsQuery.refetch();
                void accessQuery.refetch();
              }}
            />
          ) : null}
          {accessReady && canManageVault ? (
            <>
              <VaultAccessSettingsCard mode={accessMode} />

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <IconKey size={16} />
                  {secretsLoading ? (
                    <Skeleton className="h-4 w-20" />
                  ) : (
                    <span>
                      {`${secrets?.length || 0} secret${(secrets?.length || 0) !== 1 ? "s" : ""}`}
                    </span>
                  )}
                </div>
                <AddSecretDialog />
              </div>

              {!secretsQuery.isError &&
              secretsLoading &&
              (secrets ?? []).length === 0
                ? Array.from({ length: 3 }).map((_, index) => (
                    <div
                      key={index}
                      className="rounded-2xl bg-card px-5 py-4 space-y-2"
                    >
                      <Skeleton className="h-4 w-1/3" />
                      <Skeleton className="h-3 w-2/3" />
                    </div>
                  ))
                : (secrets || []).map((secret: any) => (
                    <SecretRow
                      key={secret.id}
                      secret={secret}
                      grants={grantsBySecret[secret.id] || []}
                      accessMode={accessMode}
                    />
                  ))}

              {!secretsQuery.isError &&
                !secretsLoading &&
                (secrets?.length || 0) === 0 && (
                  <div className="rounded-2xl border border-dashed px-6 py-12 text-center">
                    <IconKey
                      size={32}
                      className="mx-auto text-muted-foreground/50"
                    />
                    <h3 className="mt-3 text-sm font-medium text-foreground">
                      No secrets yet
                    </h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Add your first secret to start sharing credentials across
                      workspace apps.
                    </p>
                  </div>
                )}
            </>
          ) : null}
        </TabsContent>

        <TabsContent value="requests" className="mt-4 space-y-3">
          {requestsQuery.isError ? (
            <ActionQueryError
              error={requestsQuery.error}
              onRetry={() => void requestsQuery.refetch()}
            />
          ) : null}
          {(requests || []).map((request: any) => (
            <RequestRow
              key={request.id}
              request={request}
              canManage={canManageVault}
            />
          ))}
          {!requestsQuery.isError && (requests?.length || 0) === 0 && (
            <div className="rounded-2xl border border-dashed px-6 py-12 text-center text-sm text-muted-foreground">
              No secret requests yet.
            </div>
          )}
        </TabsContent>

        {canManageVault ? (
          <TabsContent value="audit" className="mt-4">
            <VaultAuditTab />
          </TabsContent>
        ) : null}
      </Tabs>
    </DispatchShell>
  );
}
