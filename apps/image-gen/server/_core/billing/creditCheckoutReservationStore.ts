import { and, eq } from "drizzle-orm";

import {
  billingExecutionControls,
  billingSchedulerTenants,
} from "../../../drizzle/schema";
import { getDatabaseOrThrow } from "../../db";
import type { MollieMode } from "./config";

export async function readCreditCheckoutAuthorization(input: {
  workspaceId: number;
  mode: MollieMode;
}): Promise<Readonly<{ authorizationEpoch: number }> | null> {
  const database = await getDatabaseOrThrow();
  const rows = await database
    .select({
      commercialEnabled: billingExecutionControls.commercialEnabled,
      authorizationEpoch: billingExecutionControls.authorizationEpoch,
      outboxEnabled: billingSchedulerTenants.enabled,
      executionEpoch: billingSchedulerTenants.executionEpoch,
    })
    .from(billingExecutionControls)
    .innerJoin(
      billingSchedulerTenants,
      and(
        eq(
          billingSchedulerTenants.workspaceId,
          billingExecutionControls.workspaceId
        ),
        eq(billingSchedulerTenants.mode, billingExecutionControls.mode),
        eq(billingSchedulerTenants.kind, "outbox")
      )
    )
    .where(
      and(
        eq(billingExecutionControls.workspaceId, input.workspaceId),
        eq(billingExecutionControls.mode, input.mode)
      )
    )
    .limit(2);
  if (
    rows.length !== 1 ||
    !rows[0]?.commercialEnabled ||
    !rows[0]?.outboxEnabled ||
    !Number.isSafeInteger(rows[0].authorizationEpoch) ||
    rows[0].authorizationEpoch < 1 ||
    rows[0].executionEpoch !== rows[0].authorizationEpoch
  ) {
    return null;
  }
  return Object.freeze({ authorizationEpoch: rows[0].authorizationEpoch });
}
