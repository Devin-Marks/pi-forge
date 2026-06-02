#!/bin/bash
# Bootstrap the pi-forge secret. Run ONCE, before applying
# deployment.yaml. Re-run any time you want to rotate values.
#
#   ./kubernetes/openshift/secret.sh
#
# Defaults: empty UI_PASSWORD/API_KEY/LDAP_BIND_PASSWORD (auth disabled
# unless you set UI_PASSWORD, API_KEY, or LDAP_ENABLED plus LDAP_* settings).
# JWT_SECRET is intentionally NOT set here — when UI_PASSWORD or LDAP is enabled, the
# server auto-generates one on first boot and persists it to
# ${FORGE_DATA_DIR}/jwt-secret on the data-dir PVC, so issued
# tokens survive pod restarts.
#
# Edit the --from-literal values below before running to enable
# password / API-key auth out of the gate, OR run
# `oc edit secret pi-forge-secret -n pi-forge` afterwards.
# Add a JWT_SECRET key only if you want to manage it centrally
# (e.g. via an external-secrets controller).
set -euo pipefail

kubectl create secret generic pi-forge-secret \
  --namespace=pi-forge \
  --from-literal=UI_PASSWORD="" \
  --from-literal=API_KEY="" \
  --from-literal=LDAP_BIND_PASSWORD="" \
  --dry-run=client -o yaml | oc apply -f -
