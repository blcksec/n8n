import { EventMessageGeneric } from '../EventMessageClasses/EventMessageGeneric';
import {
	MessageEventBusDestination,
	MessageEventBusDestinationOptions,
} from './MessageEventBusDestination';
import { JsonObject, JsonValue } from 'n8n-workflow';
import * as Sentry from '@sentry/node';
import { eventBus } from '../MessageEventBus/MessageEventBus';
import { getInstanceOwner } from '../../UserManagement/UserManagementHelper';
import { EventMessageLevel } from '../EventMessageClasses';
import { MessageEventBusDestinationTypeNames } from '.';

export const isMessageEventBusDestinationSentryOptions = (
	candidate: unknown,
): candidate is MessageEventBusDestinationSentryOptions => {
	const o = candidate as MessageEventBusDestinationSentryOptions;
	if (!o) return false;
	return o.dsn !== undefined;
};

function eventMessageLevelToSentrySeverity(emLevel: EventMessageLevel): Sentry.SeverityLevel {
	switch (emLevel) {
		case EventMessageLevel.log:
			return 'log';
		case EventMessageLevel.debug:
			return 'debug';
		case EventMessageLevel.info:
			return 'info';
		case EventMessageLevel.error:
			return 'error';
		case EventMessageLevel.verbose:
			return 'debug';
		case EventMessageLevel.warn:
			return 'warning';
		default:
			return 'log';
	}
}

export interface MessageEventBusDestinationSentryOptions extends MessageEventBusDestinationOptions {
	dsn: string;
	tracesSampleRate?: number;
}

export class MessageEventBusDestinationSentry extends MessageEventBusDestination {
	static readonly __type = MessageEventBusDestinationTypeNames.sentry;

	readonly dsn: string;

	tracesSampleRate: number;

	constructor(options: MessageEventBusDestinationSentryOptions) {
		super(options);
		this.dsn = options.dsn;
		this.tracesSampleRate = options.tracesSampleRate ?? 1.0;
		const { N8N_VERSION: release, ENVIRONMENT: environment } = process.env;

		Sentry.init({
			dsn: this.dsn,
			tracesSampleRate: this.tracesSampleRate,
			environment,
			release,
		});
		console.debug(`MessageEventBusDestinationSentry Broker initialized`);
	}

	//TODO: fill all event fields
	async receiveFromEventBus(msg: EventMessageGeneric): Promise<boolean> {
		try {
			const user = await getInstanceOwner();
			const context = {
				level: eventMessageLevelToSentrySeverity(msg.level),
				user: {
					id: user.id,
					email: user.email,
				},
				tags: {
					event: msg.getEventName(),
					group: msg.getEventGroup(),
					logger: this.getName(),
				},
			};
			const sentryResult = Sentry.captureMessage(
				msg.payload ? JSON.stringify(msg.payload) : msg.eventName,
				context,
			);
			if (sentryResult) {
				await eventBus.confirmSent(msg);
				return true;
			}
		} catch (error) {
			console.log(error);
		}
		return false;
	}

	serialize(): JsonValue {
		return {
			__type: MessageEventBusDestinationSentry.__type,
			options: {
				id: this.getId(),
				name: this.getName(),
				dsn: this.dsn,
				tracesSampleRate: this.tracesSampleRate,
				// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
				subscriptionSet: this.subscriptionSet.serialize(),
			},
		};
	}

	static deserialize(data: JsonObject): MessageEventBusDestinationSentry | null {
		if (
			'__type' in data &&
			data.__type === MessageEventBusDestinationSentry.__type &&
			'options' in data &&
			isMessageEventBusDestinationSentryOptions(data.options)
		) {
			return new MessageEventBusDestinationSentry(data.options);
		}
		return null;
	}

	toString() {
		return JSON.stringify(this.serialize());
	}

	async close() {
		await super.close();
		await Sentry.close();
	}
}