import { JsonValue, LoggerProxy } from 'n8n-workflow';
import { DeleteResult } from 'typeorm';
import {
	EventMessageSubscriptionSet,
	EventMessageSubscriptionSetOptions,
} from '../MessageEventBusDestination/EventMessageSubscriptionSet';
import { EventMessageTypes } from '../EventMessageClasses/';
import { MessageEventBusDestination } from '../MessageEventBusDestination/MessageEventBusDestination';
import { MessageEventBusLogWriter } from '../MessageEventBusWriter/MessageEventBusLogWriter';
import EventEmitter from 'node:events';
import config from '../../config';
import { Db } from '../..';
import { messageEventBusDestinationFromDb } from '../MessageEventBusDestination/Helpers';
import uniqby from 'lodash.uniqby';

export type EventMessageReturnMode = 'sent' | 'unsent' | 'all';

class MessageEventBus extends EventEmitter {
	static #instance: MessageEventBus;

	isInitialized: boolean;

	logWriter: MessageEventBusLogWriter;

	destinations: {
		[key: string]: MessageEventBusDestination;
	} = {};

	#pushInteralTimer: NodeJS.Timer;

	constructor() {
		super();
		this.isInitialized = false;
	}

	static getInstance(): MessageEventBus {
		if (!MessageEventBus.#instance) {
			MessageEventBus.#instance = new MessageEventBus();
		}
		if (!MessageEventBus.#instance.isInitialized) {
			// console.log(
			// 	'eventBus called before initialization. Call eventBus.initialize() once before use.',
			// );
		}
		return MessageEventBus.#instance;
	}

	/**
	 * Needs to be called once at startup to set the event bus instance up. Will launch the event log writer and,
	 * if configured to do so, the previously stored event destinations.
	 *
	 * Will check for unsent event messages in the previous log files once at startup and try to re-send them.
	 *
	 * Sets `isInitialized` to `true` once finished.
	 */
	async initialize() {
		console.error('HERE');
		if (this.isInitialized) {
			return;
		}

		LoggerProxy.debug('Initializing event bus...');

		// Load stored destinations from Db and instantiate them
		if (config.getEnv('eventBus.destinations.loadAtStart')) {
			LoggerProxy.debug('Restoring event destinations');
			const savedEventDestinations = await Db.collections.EventDestinations.find({});
			if (savedEventDestinations.length > 0) {
				for (const destinationData of savedEventDestinations) {
					try {
						const destination = messageEventBusDestinationFromDb(destinationData);
						if (destination) {
							await this.addDestination(destination);
						}
					} catch (error) {
						console.log(error);
					}
				}
			}
		}

		LoggerProxy.debug('Initializing event writer');
		this.logWriter = await MessageEventBusLogWriter.getInstance();

		// unsent event check:
		// - find unsent messages in current event log(s)
		// - cycle event logs and start the logging to a fresh file
		// - retry sending events
		LoggerProxy.debug('Checking for unsent event messages');
		const unsentMessages = await this.getEventsUnsent();
		LoggerProxy.debug(
			`Start logging into ${
				(await this.logWriter.getThread()?.getLogFileName()) ?? 'unknown filename'
			} `,
		);
		await this.logWriter.startLogging();
		await this.send(unsentMessages);

		// if configured, run this test every n ms
		if (config.getEnv('eventBus.checkUnsentInterval') > 0) {
			if (this.#pushInteralTimer) {
				clearInterval(this.#pushInteralTimer);
			}
			this.#pushInteralTimer = setInterval(async () => {
				await this.#trySendingUnsent();
			}, config.getEnv('eventBus.checkUnsentInterval'));
		}

		console.debug('MessageEventBus initialized');
		this.isInitialized = true;
	}

	async addDestination(destination: MessageEventBusDestination) {
		await this.removeDestination(destination.getId());
		this.destinations[destination.getId()] = destination;
		return destination;
	}

	async findDestination(id?: string): Promise<JsonValue[]> {
		if (id && Object.keys(this.destinations).includes(id)) {
			return [this.destinations[id].serialize()];
		} else {
			return Object.keys(this.destinations).map((e) => this.destinations[e].serialize());
		}
	}

	async removeDestination(id: string): Promise<DeleteResult | undefined> {
		let result;
		if (Object.keys(this.destinations).includes(id)) {
			await this.destinations[id].close();
			result = await this.destinations[id].deleteFromDb();
			delete this.destinations[id];
		}
		return result;
	}

	/**
	 * Resets SubscriptionsSet to empty values on the selected destination
	 * @param destinationId the destination id
	 * @returns serialized destination after reset
	 */
	getDestinationSubscriptionSet(destinationId: string): JsonValue {
		if (Object.keys(this.destinations).includes(destinationId)) {
			return this.destinations[destinationId].subscriptionSet.serialize();
		}
		return {};
	}

	/**
	 * Sets SubscriptionsSet on the selected destination
	 * @param destinationId the destination id
	 * @param subscriptionSetOptions EventMessageSubscriptionSet object containing event subscriptions
	 * @returns serialized destination after change
	 */
	setDestinationSubscriptionSet(
		destinationId: string,
		subscriptionSetOptions: EventMessageSubscriptionSetOptions,
	): MessageEventBusDestination {
		if (Object.keys(this.destinations).includes(destinationId)) {
			this.destinations[destinationId].setSubscription(subscriptionSetOptions);
		}
		return this.destinations[destinationId];
	}

	/**
	 * Resets SubscriptionsSet to empty values on the selected destination
	 * @param destinationId the destination id
	 * @returns serialized destination after reset
	 */
	resetDestinationSubscriptionSet(destinationId: string): MessageEventBusDestination {
		if (Object.keys(this.destinations).includes(destinationId)) {
			this.destinations[destinationId].setSubscription(
				new EventMessageSubscriptionSet({
					eventGroups: [],
					eventNames: [],
					eventLevels: [],
				}),
			);
		}
		return this.destinations[destinationId];
	}

	async #trySendingUnsent(msgs?: EventMessageTypes[]) {
		const unsentMessages = msgs ?? (await this.getEventsUnsent());
		if (unsentMessages.length > 0) {
			LoggerProxy.debug(`Found unsent event messages: ${unsentMessages.length}`);
			for (const unsentMsg of unsentMessages) {
				LoggerProxy.debug(`Retrying: ${unsentMsg.id} ${unsentMsg.__type}`);
				await this.#emitMessage(unsentMsg);
			}
		}
	}

	async close() {
		LoggerProxy.debug('Shutting down event writer...');
		await this.logWriter.close();
		for (const destinationName of Object.keys(this.destinations)) {
			LoggerProxy.debug(
				`Shutting down event destination ${this.destinations[destinationName].getName()}...`,
			);
			await this.destinations[destinationName].close();
		}
		LoggerProxy.debug('EventBus shut down.');
	}

	async send(msgs: EventMessageTypes | EventMessageTypes[]) {
		if (!Array.isArray(msgs)) {
			msgs = [msgs];
		}
		for (const msg of msgs) {
			console.log(new Date().getMilliseconds());
			await this.logWriter.putMessage(msg);
			await this.#emitMessage(msg);
		}
	}

	async confirmSent(msg: EventMessageTypes) {
		await this.logWriter.confirmMessageSent(msg.id);
	}

	async #emitMessage(msg: EventMessageTypes) {
		// generic emit for external modules to capture events
		this.emit('message', msg);
		console.log(this.eventNames());

		// if there are no set up destinations, immediately mark the event as sent
		if (Object.keys(this.destinations).length === 0) {
			await this.confirmSent(msg);
		} else {
			for (const destinationName of Object.keys(this.destinations)) {
				this.emit(this.destinations[destinationName].getName(), msg);
			}
		}
	}

	async getEvents(mode: EventMessageReturnMode = 'all'): Promise<EventMessageTypes[]> {
		let queryResult: EventMessageTypes[];
		switch (mode) {
			case 'all':
				queryResult = await this.logWriter.getMessages();
				break;
			case 'sent':
				queryResult = await this.logWriter.getMessagesSent();
				break;
			case 'unsent':
				queryResult = await this.logWriter.getMessagesUnsent();
		}
		// eslint-disable-next-line @typescript-eslint/no-unsafe-call
		const filtered = uniqby(queryResult, 'id') as EventMessageTypes[];
		return filtered;
	}

	async getEventsSent(): Promise<EventMessageTypes[]> {
		const sentMessages = await this.getEvents('sent');
		return sentMessages;
	}

	async getEventsUnsent(): Promise<EventMessageTypes[]> {
		const unSentMessages = await this.getEvents('unsent');
		return unSentMessages;
	}
}

export const eventBus = MessageEventBus.getInstance();