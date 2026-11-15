# Phase 1 — Foundations

**Time:** 4–6 hours · **Prerequisite:** Docker, kind, kubectl, helm installed

## Why this phase

You cannot observe something that is not running. Before any of the monitoring stack, you
need the three services running on a local cluster that behaves enough like AKS that the
manifests you write here are the manifests you would ship.

There is a second, less obvious reason. Your `k8s/base` manifests are written for AKS:
ACR images, Workload Identity, Key Vault through the Secrets Store CSI driver, Entra ID
role bindings. None of that exists on a laptop. Making the *same* manifests work in both
places, without maintaining two copies, is a real platform-engineering problem — and the
diff between your two overlays becomes a two-minute interview answer to "how do you handle
environment differences".

## Understand first

Answer these before you start. Out loud, or in the notebook.

1. What is the difference between a kustomize **base** and an **overlay**? Why is an
   overlay better than `sed`-ing the YAML in your pipeline?
2. Your Deployments have `topologySpreadConstraints` on `topology.kubernetes.io/zone` with
   `whenUnsatisfiable: DoNotSchedule`. What happens to the second replica on a
   single-node cluster with no zone labels? Why does nothing tell you clearly?
3. Your pods mount secrets through the Secrets Store CSI driver, and `envFrom` references
   a Secret the driver creates. What state is the pod in if the driver is not installed?
4. What does `kind load docker-image` actually do, and why is a locally built image not
   visible to a kind node without it?
5. What does an HPA report when `metrics-server` is missing, and why is that easy to
   misread as "the HPA is broken"?

## Read

- [kind — configuration](https://kind.sigs.k8s.io/docs/user/configuration/) — nodes,
  `extraPortMappings`, `kubeadmConfigPatches`
- [kustomize — overlays and patches](https://kubectl.docs.kubernetes.io/references/kustomize/kustomization/)
  — `patches`, `images`, `secretGenerator`, and the difference between a strategic-merge
  patch and a JSON6902 patch
- [Kubernetes — Pod topology spread constraints](https://kubernetes.io/docs/concepts/scheduling-eviction/topology-spread-constraints/)
  — just the `whenUnsatisfiable` section

## Build

### 1.1 A kind cluster that looks like a small AKS cluster

One control-plane and three workers. Two things beyond the default config:

- label each worker with a distinct `topology.kubernetes.io/zone` value, so your existing
  `topologySpreadConstraints` can actually be satisfied;
- map host ports so you can reach ingress, and later Grafana and Prometheus, without
  keeping a `port-forward` alive.

**Prove it:** `kubectl get nodes --show-labels | grep zone` shows three different zones.

### 1.2 ingress-nginx and metrics-server

Install both. metrics-server needs one extra argument on kind — find out which, and
understand why it is needed here and must *not* be carried to AKS.

**Prove it:** `kubectl top nodes` returns numbers rather than an error.

### 1.3 Build and load the images

Build all four images (three services + frontend) and get them into the kind nodes.

**Prove it:** `docker exec <kind-node> crictl images | grep ecommerce` lists them.

### 1.4 kustomize base and a kind overlay

Write `k8s/base/kustomization.yaml` listing your existing manifests, then
`k8s/overlays/kind/` that subtracts everything a laptop cannot provide:

- the workload-identity label (it appears in two places — find both)
- the CSI volume and its volumeMount
- the `envFrom` reference to the CSI-created Secret, replaced by a locally generated one
- the Entra ID RoleBinding
- images repointed at your local tags

Do **not** edit the base manifests to make this work. The base stays AKS-shaped; the
overlay subtracts. That constraint is the exercise.

Then write `k8s/overlays/aks/` — which, if you did the base right, is almost empty.

**Prove it:** `kustomize build k8s/overlays/kind` exits 0, and
`diff <(kustomize build k8s/overlays/kind) <(kustomize build k8s/overlays/aks)` shows
*only* environment differences.

### 1.5 Run it

Apply the kind overlay. Get every pod Running and Ready, and every HPA reporting real
percentages instead of `<unknown>`.

**Prove it:**

```bash
kubectl get pods -n ecommerce-dev -o wide     # 2 replicas each, spread across zones
kubectl get hpa -n ecommerce-dev              # real numbers, not <unknown>
curl -s localhost:<your-port>/products | head # the app answers
```

## Self-check

- Why is a Deployment's `selector` immutable, and what does that mean for adding labels
  through kustomize `labels`/`commonLabels`?
- Your PDBs say `minAvailable: 2` and your Deployments run 2 replicas. What happens when
  someone runs `kubectl drain` on a node running one of those pods? Is that what you want?
- A pod is `Pending` with no events beyond "0/4 nodes available". List four different
  causes and the command that distinguishes them.
- Why does the overlay generate a Secret rather than committing one?

## If you're stuck

- **Pods Pending forever:** `kubectl describe pod` and read the scheduling predicate that
  failed. If it mentions "node(s) didn't match pod topology spread constraints", your zone
  labels are the problem — and note that the constraint's `labelSelector` must match the
  labels the pods *actually* carry after your overlay has finished with them.
- **`kustomize build` says "no matches for Id":** a strategic-merge patch is matched by
  apiVersion, kind, name **and namespace**. Your resources have a namespace; does your
  patch?
- **`kustomize build` refuses a file path:** kustomize will not load a plain file from
  outside the kustomization's own directory. A *directory* with its own kustomization can
  be referenced from anywhere — look up what a kustomize **Component** is.
- **`envFrom` can't find the Secret:** `secretGenerator` appends a content hash to the
  name by default. Either reference the hashed name (kustomize rewrites references it
  knows about) or turn the suffix off — and understand which one you chose and why.
- **HPA shows `<unknown>`:** it is not the HPA. It is metrics-server, and on kind it is
  the kubelet's self-signed certificate.
- **ImagePullBackOff on a local image:** kind nodes run their own containerd. Also check
  `imagePullPolicy` — a tag that is not `:latest` defaults to `IfNotPresent`, which is
  what you want here.

## Review checkpoint

Show me:

1. `k8s/overlays/kind/kustomization.yaml` and your patch files
2. The output of `diff <(kustomize build k8s/overlays/kind) <(kustomize build k8s/overlays/aks)`
3. `kubectl get pods -n ecommerce-dev -o wide`

I will push on: whether the base is still deployable to AKS unchanged; whether you
patched something you should have left alone; what your PDBs do during a node drain; and
whether you can explain every field you added rather than the ones you copied.

## After this phase you can say

> "The manifests are environment-neutral in a kustomize base, with overlays that subtract
> what each environment cannot provide. The local one strips Workload Identity and the
> Key Vault CSI mounts; the diff between the two overlays is the complete list of what
> changes between my laptop and AKS."
