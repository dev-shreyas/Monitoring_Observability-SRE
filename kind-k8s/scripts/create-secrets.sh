#!/usr/bin/env bash
# Creates the three app Secrets in ecommerce-dev WITHOUT any value ever living in git.
#
# Replaces kind-k8s/base/secrets.yaml, which held the JWT signing key in plaintext.
# Anyone who read that file could mint a valid token for any user. Same pattern as
# the grafana-admin Secret: values are generated or typed at setup, never committed.
#
# Usage:
#   ./kind-k8s/scripts/create-secrets.sh            # create if missing, keep existing JWT secret
#   ./kind-k8s/scripts/create-secrets.sh --rotate   # generate a NEW JWT secret (logs everyone out)
#
# Creates JWT_SECRET (all three services) and INTERNAL_API_TOKEN (order- and product-service).
# After a rotation, restart the pods that read them (envFrom is read only at start):
#   kubectl -n ecommerce-dev rollout restart deploy/user-service deploy/order-service deploy/product-service
set -euo pipefail

NS=ecommerce-dev
ROTATE=false
[[ "${1:-}" == "--rotate" ]] && ROTATE=true

kubectl get namespace "$NS" >/dev/null

# Keep the current JWT secret unless asked to rotate: changing it invalidates every
# token already issued, which signs every shopper out.
current_jwt() {
  kubectl -n "$NS" get secret user-service-secrets -o jsonpath='{.data.JWT_SECRET}' 2>/dev/null | base64 -d 2>/dev/null || true
}

JWT_SECRET="$(current_jwt)"
case "$JWT_SECRET" in
  # The value that used to be committed is public -- always replace it.
  ""|"local-dev-shared-jwt-secret-not-for-production"|"dev-only-insecure-secret-change-me") ROTATE=true ;;
esac
if $ROTATE; then
  # 48 random bytes -> 64 base64 characters. The services refuse anything under 32.
  JWT_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
  echo "Generated a new JWT secret (${#JWT_SECRET} characters). Existing logins are now invalid."
else
  echo "Keeping the existing JWT secret (pass --rotate to replace it)."
fi

# Service-to-service token for the /internal APIs (stock reservations, order transitions).
# Kept across runs like the JWT secret; --rotate replaces it too.
INTERNAL_API_TOKEN="$(kubectl -n "$NS" get secret order-service-secrets -o jsonpath='{.data.INTERNAL_API_TOKEN}' 2>/dev/null | base64 -d 2>/dev/null || true)"
if $ROTATE || [[ ${#INTERNAL_API_TOKEN} -lt 32 ]]; then
  INTERNAL_API_TOKEN="$(openssl rand -hex 32)"
  echo "Generated a new internal API token."
fi

# create --dry-run | apply = idempotent "create or update", and the value is passed on
# the command line of a local process only -- it is never written to disk.
apply_secret() {
  local name=$1; shift
  kubectl -n "$NS" create secret generic "$name" "$@" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  echo "  secret/$name applied"
}

# One shared JWT secret: user-service SIGNS tokens, order- and product-service VERIFY
# them, so all three must hold the same value or every authenticated call returns 401.
# Empty SQL / Service Bus / Cosmos values select the Redis / in-memory / logging
# fallbacks, which is what you want on kind.
apply_secret user-service-secrets \
  --from-literal=JWT_SECRET="$JWT_SECRET" \
  --from-literal=SQL_CONNECTION_STRING=""
apply_secret order-service-secrets \
  --from-literal=JWT_SECRET="$JWT_SECRET" \
  --from-literal=INTERNAL_API_TOKEN="$INTERNAL_API_TOKEN" \
  --from-literal=SQL_CONNECTION_STRING="" \
  --from-literal=SERVICE_BUS_CONNECTION_STRING=""
apply_secret product-service-secrets \
  --from-literal=JWT_SECRET="$JWT_SECRET" \
  --from-literal=INTERNAL_API_TOKEN="$INTERNAL_API_TOKEN" \
  --from-literal=COSMOS_ENDPOINT="" \
  --from-literal=COSMOS_KEY=""

unset JWT_SECRET INTERNAL_API_TOKEN
echo "Done. Restart the services if the secret changed."
