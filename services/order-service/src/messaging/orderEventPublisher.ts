/**
 * Azure Service Bus publisher — the async half of the architecture.
 *
 * WHY this exists at all (guide section 2): when an order is placed, several
 * things must happen — reserve inventory, email a receipt, update analytics.
 * If order-service called each of those synchronously, checkout would be as
 * slow as the slowest one and would FAIL if any one of them was down.
 *
 * Instead we write the order to SQL and publish one `order.placed` event.
 * Consumers subscribe at their own pace. Checkout stays fast, and a broken
 * email service can no longer break checkout.
 */
import { randomUUID } from "node:crypto";
import { config } from "../config";
import { logger } from "../logger";

/** The event contract. Consumers depend on this shape — version it carefully. */
export interface OrderPlacedEvent {
  eventId: string;
  eventType: "order.placed";
  occurredAt: string;
  orderId: string;
  userId: string;
  totalMinor: number;
  currency: string;
  items: Array<{ productId: string; quantity: number; unitPriceMinor: number }>;
}

export interface OrderEventPublisher {
  publish(event: OrderPlacedEvent): Promise<void>;
}

/**
 * Local/dev implementation: writes the event to the log instead of a topic.
 * The service therefore runs end-to-end with no Azure resources at all, and
 * you can still see exactly what WOULD have been published.
 */
export class LoggingOrderEventPublisher implements OrderEventPublisher {
  /** Kept so tests can assert what was published. */
  public readonly published: OrderPlacedEvent[] = [];

  async publish(event: OrderPlacedEvent): Promise<void> {
    this.published.push(event);
    logger.info("order event published (local stub)", {
      eventType: event.eventType,
      orderId: event.orderId
    });
  }
}

export function createOrderEventPublisher(): OrderEventPublisher {
  if (config.serviceBus.connectionString) {
    // <<< REPLACE ME >>> The real publisher goes here:
    //   const client = new ServiceBusClient(config.serviceBus.connectionString);
    //   return new ServiceBusOrderEventPublisher(client.createSender(config.serviceBus.topic));
    logger.warn("SERVICE_BUS_CONNECTION_STRING is set but no Service Bus publisher is implemented yet; logging events instead");
  }
  return new LoggingOrderEventPublisher();
}

/** Helper so route code does not hand-build eventId/occurredAt every time. */
export function newOrderPlacedEvent(
  fields: Omit<OrderPlacedEvent, "eventId" | "eventType" | "occurredAt">
): OrderPlacedEvent {
  return {
    eventId: randomUUID(),
    eventType: "order.placed",
    occurredAt: new Date().toISOString(),
    ...fields
  };
}
