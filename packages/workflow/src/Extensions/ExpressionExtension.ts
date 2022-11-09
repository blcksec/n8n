/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable import/first */
/* eslint-disable max-classes-per-file */
/* eslint-disable import/no-cycle */
/* eslint-disable no-param-reassign */

import * as BabelCore from '@babel/core';
import * as BabelTypes from '@babel/types';
import { DateTime, Interval, Duration } from 'luxon';
import { ExpressionExtensionError } from '../ExpressionError';
import { NumberExtensions } from './NumberExtensions';

import { DateExtensions } from './DateExtensions';
import { StringExtensions } from './StringExtensions';
import { ArrayExtensions } from './ArrayExtensions';

const EXPRESSION_EXTENDER = 'extend';

const stringExtensions = new StringExtensions();
const dateExtensions = new DateExtensions();
const arrayExtensions = new ArrayExtensions();
const numberExtensions = new NumberExtensions();

const EXPRESSION_EXTENSION_METHODS = Array.from(
	new Set([
		...stringExtensions.listMethods(),
		...numberExtensions.listMethods(),
		...dateExtensions.listMethods(),
		...arrayExtensions.listMethods(),
		'isBlank',
		'isPresent',
		'toDecimal',
		'toLocaleString',
		'random',
		'format',
	]),
);

const isExpressionExtension = (str: string) => EXPRESSION_EXTENSION_METHODS.some((m) => m === str);

export const hasExpressionExtension = (str: string): boolean =>
	EXPRESSION_EXTENSION_METHODS.some((m) => str.includes(m));

export const hasNativeMethod = (method: string): boolean => {
	if (hasExpressionExtension(method)) {
		return false;
	}
	const methods = method
		.replace(/[^\w\s]/gi, ' ')
		.split(' ')
		.filter(Boolean); // DateTime.now().toLocaleString().format() => [DateTime,now,toLocaleString,format]
	return methods.every((methodName) => {
		return [String.prototype, Array.prototype, Number.prototype, Date.prototype].some(
			(nativeType) => {
				if (methodName in nativeType) {
					return true;
				}

				return false;
			},
		);
	});
};

/**
 * Babel plugin to inject an extender function call into the AST of an expression.
 *
 * ```ts
 * 'a'.method('x') // becomes
 * extend('a', 'x').method();
 *
 * 'a'.first('x').second('y') // becomes
 * extend(extend('a', 'x').first(), 'y').second();
 * ```
 */
export function expressionExtensionPlugin(): {
	visitor: {
		// eslint-disable-next-line @typescript-eslint/naming-convention
		Identifier(path: BabelCore.NodePath<BabelTypes.Identifier>): void;
	};
} {
	return {
		visitor: {
			// eslint-disable-next-line @typescript-eslint/naming-convention
			Identifier(path: BabelCore.NodePath<BabelTypes.Identifier>) {
				if (isExpressionExtension(path.node.name) && BabelTypes.isMemberExpression(path.parent)) {
					const callPath = path.findParent((p) => p.isCallExpression());

					if (!callPath || !BabelTypes.isCallExpression(callPath.node)) return;

					path.parent.object = BabelTypes.callExpression(
						BabelTypes.identifier(EXPRESSION_EXTENDER),
						[path.parent.object, ...callPath.node.arguments],
					);

					callPath.node.arguments = [];
				}
			},
		},
	};
}

/**
 * Extender function injected by expression extension plugin to allow calls to extensions.
 *
 * ```ts
 * extend(mainArg, ...extraArgs).method();
 * ```
 */
type StringExtMethods = () => string;
type BooleanExtMethods = () => boolean;
type DateTimeMethods = () => typeof DateTime;
type IntervalMethods = () => Interval | typeof Interval;
type DurationMethods = () => Duration | typeof Duration;
type ExtMethods = {
	[k: string]:
		| StringExtMethods
		| BooleanExtMethods
		| DateTimeMethods
		| IntervalMethods
		| DurationMethods;
};

export function extend(mainArg: unknown, ...extraArgs: unknown[]): ExtMethods {
	const higherLevelExtensions: ExtMethods = {
		/*
		 *	Methods that are defined here are executing extended methods
		 *  based on specific types. i.e. Array .random() & Number.random()
		 */
		format(): string {
			if (typeof mainArg === 'number') {
				return numberExtensions.format(Number(mainArg), extraArgs);
			}

			if ('isLuxonDateTime' in (mainArg as any) || mainArg instanceof Date) {
				const date = new Date(mainArg as string);
				return dateExtensions.format(date, extraArgs);
			}

			throw new ExpressionExtensionError('format() is only callable on types "Number" and "Date"');
		},
		getOnlyFirstCharacters(): string {
			const [end] = extraArgs as number[];

			if (!end || extraArgs.length > 1) {
				throw new ExpressionExtensionError('getOnlyFirstCharacters() requires a single argument');
			}

			if (typeof mainArg === 'string' || typeof mainArg === 'number') {
				return stringExtensions.getOnlyFirstCharacters(String(mainArg), end);
			}

			if ('isLuxonDateTime' in (mainArg as DateTime) || mainArg instanceof Date) {
				throw new ExpressionExtensionError(
					"getOnlyFirstCharacters() is only callable on type 'String'",
				);
			}

			return mainArg as string;
		},
		isBlank(): boolean {
			if (typeof mainArg === 'string') {
				return stringExtensions.isBlank(mainArg);
			}

			if (typeof mainArg === 'number') {
				return numberExtensions.isBlank(Number(mainArg));
			}

			if (Array.isArray(mainArg)) {
				return arrayExtensions.isBlank(mainArg);
			}

			throw new ExpressionExtensionError(
				'isBlank() is only callable on types "String", "Array", and "Number"',
			);
		},
		isPresent(): boolean {
			if (typeof mainArg === 'string') {
				return stringExtensions.isPresent(mainArg);
			}

			if (typeof mainArg === 'number') {
				return numberExtensions.isPresent(Number(mainArg));
			}

			if (Array.isArray(mainArg)) {
				return arrayExtensions.isPresent(mainArg);
			}

			throw new ExpressionExtensionError(
				'isPresent() is only callable on types "String", "Array", and "Number"',
			);
		},
		random(): number | any {
			if (typeof mainArg === 'number') {
				return numberExtensions.random(Number(mainArg));
			}

			if (Array.isArray(mainArg)) {
				return arrayExtensions.random(mainArg);
			}

			throw new ExpressionExtensionError('random() is only callable on types "Number" and "Array"');
		},
		toLocaleString(): string {
			if ('isLuxonDateTime' in (mainArg as DateTime) || mainArg instanceof Date) {
				return dateExtensions.toLocaleString(new Date(mainArg as string), extraArgs);
			}
			throw new ExpressionExtensionError('toLocaleString() is only callable on a "Date" type');
		},

		/*
		 * Type specific extensions and bound to the data
		 * and are added to the higherLevelExtensions object 'exposed' at this point
		 */
		...stringExtensions.bind(mainArg as string, extraArgs as string[] | undefined),
		...numberExtensions.bind(Number(mainArg), extraArgs as any[] | undefined),
		...dateExtensions.bind(
			new Date(mainArg as string),
			extraArgs as number[] | string[] | boolean[] | undefined,
		),
		...arrayExtensions.bind(
			Array.isArray(mainArg) ? mainArg : ([mainArg] as unknown[]),
			extraArgs as string[] | undefined,
		),
	};

	return higherLevelExtensions;
}