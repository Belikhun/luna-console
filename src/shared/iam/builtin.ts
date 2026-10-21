// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The built-in managed policies. Code, never stored, shown read-only, and
 * attached by name like any other managed policy, so `iam.json` only ever holds
 * the name.
 *
 * `OwnerAccess` and `SelfServiceAccess` are what every new account gets: an
 * account may do anything to what it created, and may look after its own
 * password, sessions and identities. Both are ordinary attachments afterwards.
 */

import { IAM_ACTIONS } from "./actions";
import type { PolicyDocument } from "./grammar";

export interface BuiltinPolicy {
	name: string;
	/** Language key for what it grants */
	descriptionKey: string;
	document: PolicyDocument;
	/** The document as the editor shows it; YAML, read-only */
	yaml: string;
}

const readActions = IAM_ACTIONS.filter((spec) => spec.access === "read").map((spec) => spec.name);

/**
 * The listings an owner needs to reach what it created, and the reads every
 * screen leans on. Deliberately not `*:List`: accounts, machines, players and
 * tokens are not things an account creates and keeps, and listing them is a
 * grant of its own.
 */
const OWNER_LISTINGS = [
	"instance:List",
	"plugin:List",
	"pack:List",
	"datapack:List",
	"addon-group:List",
	"profile:List",
	"port-pool:List",
	"domain:List",
	"schedule:List",
	"env:List",
	"knowledge:List",
	"tag:List",
	"catalog:Read",
	"event:Read",
	"job:Describe",
	"network:Describe",
];

function yamlList(values: string[], indent: string): string {
	return values.map((value) => `${indent}- ${value}`).join("\n");
}

export const BUILTIN_POLICIES: BuiltinPolicy[] = [
	{
		name: "AdministratorAccess",
		descriptionKey: "core.iam.builtin.AdministratorAccess",
		document: {
			Version: 1,
			Statement: [{ Sid: "Everything", Effect: "Allow", Action: ["*"], Resource: ["*"] }],
		},
		yaml: [
			"Version: 1",
			"Statement:",
			"  - Sid: Everything",
			"    Effect: Allow",
			"    Action: \"*\"",
			"    Resource: \"*\"",
			"",
		].join("\n"),
	},
	{
		name: "PowerUserAccess",
		descriptionKey: "core.iam.builtin.PowerUserAccess",
		document: {
			Version: 1,
			Statement: [
				{
					Sid: "EverythingButAccess",
					Effect: "Allow",
					NotAction: ["iam:*", "account:*", "shell:*", "chat:*"],
					Resource: ["*"],
				},
			],
		},
		yaml: [
			"Version: 1",
			"Statement:",
			"  - Sid: EverythingButAccess",
			"    Effect: Allow",
			"    NotAction:",
			"      - \"iam:*\"",
			"      - \"account:*\"",
			"      - \"shell:*\"",
			"      - \"chat:*\"",
			"    Resource: \"*\"",
			"",
		].join("\n"),
	},
	{
		name: "ReadOnlyAccess",
		descriptionKey: "core.iam.builtin.ReadOnlyAccess",
		document: {
			Version: 1,
			Statement: [{ Sid: "Reads", Effect: "Allow", Action: readActions, Resource: ["*"] }],
		},
		yaml: [
			"Version: 1",
			"Statement:",
			"  - Sid: Reads",
			"    Effect: Allow",
			"    Action:",
			yamlList(readActions, "      "),
			"    Resource: \"*\"",
			"",
		].join("\n"),
	},
	{
		name: "OwnerAccess",
		descriptionKey: "core.iam.builtin.OwnerAccess",
		document: {
			Version: 1,
			Statement: [
				{
					Sid: "WhatICreated",
					Effect: "Allow",
					// owning a server is not a licence to read what its players
					// wrote: chat is granted only by a policy that names it
					NotAction: ["chat:*"],
					Resource: ["*"],
					Condition: { StringEquals: { "luna:ResourceCreator": ["${luna:username}"] } },
				},
				// a listing names no resource, so the statement above cannot reach it;
				// without these the owner could never open the screen its instances are on
				{
					Sid: "Listings",
					Effect: "Allow",
					Action: OWNER_LISTINGS,
					Resource: ["*"],
				},
			],
		},
		yaml: [
			"Version: 1",
			"Statement:",
			"  - Sid: WhatICreated",
			"    Effect: Allow",
			"    NotAction: \"chat:*\"",
			"    Resource: \"*\"",
			"    Condition:",
			"      StringEquals:",
			"        luna:ResourceCreator: \"${luna:username}\"",
			"  - Sid: Listings",
			"    Effect: Allow",
			"    Action:",
			yamlList(OWNER_LISTINGS, "      "),
			"    Resource: \"*\"",
			"",
		].join("\n"),
	},
	{
		name: "SelfServiceAccess",
		descriptionKey: "core.iam.builtin.SelfServiceAccess",
		document: {
			Version: 1,
			Statement: [
				{
					Sid: "MyOwnAccount",
					Effect: "Allow",
					Action: [
						"account:Describe",
						"account:SetPassword",
						"account:ManageSessions",
						"account:ManageIdentities",
						"account:Update",
						"tag:Describe",
					],
					Resource: ["luna:account/${luna:username}"],
				},
				{
					Sid: "MyOwnChats",
					Effect: "Allow",
					Action: ["agent:Describe", "agent:Chat"],
					Resource: ["*"],
				},
				// what decides an account's access is the account's own business: the
				// policies that reach it and the groups it is in, read but not changed
				{
					Sid: "MyOwnPolicies",
					Effect: "Allow",
					Action: ["iam:DescribePolicy", "tag:Describe"],
					Resource: ["luna:policy/*"],
					Condition: { "ForAnyValue:StringEquals": { "luna:PolicyPrincipals": ["${luna:username}"] } },
				},
				{
					Sid: "MyOwnGroups",
					Effect: "Allow",
					Action: ["iam:DescribeGroup", "tag:Describe"],
					Resource: ["luna:group/*"],
					Condition: { "ForAnyValue:StringEquals": { "luna:GroupMembers": ["${luna:username}"] } },
				},
			],
		},
		yaml: [
			"Version: 1",
			"Statement:",
			"  - Sid: MyOwnAccount",
			"    Effect: Allow",
			"    Action:",
			"      - account:Describe",
			"      - account:SetPassword",
			"      - account:ManageSessions",
			"      - account:ManageIdentities",
			"      - account:Update",
			"      - tag:Describe",
			"    Resource: luna:account/${luna:username}",
			"  - Sid: MyOwnChats",
			"    Effect: Allow",
			"    Action:",
			"      - agent:Describe",
			"      - agent:Chat",
			"    Resource: \"*\"",
			"  - Sid: MyOwnPolicies",
			"    Effect: Allow",
			"    Action:",
			"      - iam:DescribePolicy",
			"      - tag:Describe",
			"    Resource: luna:policy/*",
			"    Condition:",
			"      ForAnyValue:StringEquals:",
			"        luna:PolicyPrincipals: \"${luna:username}\"",
			"  - Sid: MyOwnGroups",
			"    Effect: Allow",
			"    Action:",
			"      - iam:DescribeGroup",
			"      - tag:Describe",
			"    Resource: luna:group/*",
			"    Condition:",
			"      ForAnyValue:StringEquals:",
			"        luna:GroupMembers: \"${luna:username}\"",
			"",
		].join("\n"),
	},
	{
		name: "ChatReadAccess",
		descriptionKey: "core.iam.builtin.ChatReadAccess",
		document: {
			Version: 1,
			Statement: [{ Sid: "AllChat", Effect: "Allow", Action: ["chat:*"], Resource: ["luna:chat/*", "luna:player/*"] }],
		},
		yaml: [
			"Version: 1",
			"Statement:",
			"  - Sid: AllChat",
			"    Effect: Allow",
			"    Action: \"chat:*\"",
			"    Resource:",
			"      - \"luna:chat/*\"",
			"      - \"luna:player/*\"",
			"",
		].join("\n"),
	},
	{
		name: "DenyChatAccess",
		descriptionKey: "core.iam.builtin.DenyChatAccess",
		document: {
			Version: 1,
			Statement: [{ Sid: "NoChat", Effect: "Deny", Action: ["chat:*"], Resource: ["*"] }],
		},
		yaml: [
			"Version: 1",
			"Statement:",
			"  - Sid: NoChat",
			"    Effect: Deny",
			"    Action: \"chat:*\"",
			"    Resource: \"*\"",
			"",
		].join("\n"),
	},
];

/** What a new account is attached to until somebody changes it. */
export const DEFAULT_ATTACHMENTS: string[] = ["OwnerAccess", "SelfServiceAccess"];

/** The built-in that makes an account an administrator; the one the last-admin guard counts. */
export const ADMINISTRATOR_POLICY = "AdministratorAccess";

/** A built-in by name, or undefined. */
export function builtinPolicy(name: string): BuiltinPolicy | undefined {
	return BUILTIN_POLICIES.find((policy) => policy.name === name);
}
