# Run these from inside infra/ (where main.tf, backend.tf, and provider.tf live).
#
# Usage:
#   make plan-prod     # writes infra/tfplan, prints the plan for you to review
#   make apply-prod     # applies the tfplan from the last plan-prod run
#
# apply-prod deliberately does NOT depend on plan-prod — always run plan-prod first,
# read its output, and only then run apply-prod. That's the manual review gate;
# collapsing the two into one step would remove your chance to catch a bad plan.

TFVARS_PROD := environments/prod/prd.core.auto.tfvars

.PHONY: plan-prod apply-prod clean

plan-prod:
	terraform plan -var-file="$(TFVARS_PROD)" -out=tfplan

apply-prod:
	terraform apply tfplan

clean:
	rm -f tfplan
