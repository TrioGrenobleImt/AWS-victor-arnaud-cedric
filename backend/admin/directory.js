// Back-office accounts, stored in the Cognito user pool. A user is a back-office
// user when it is in the "admins" group; the "owners" group adds the owner role.
//
// Directory interface (also implemented in memory by dev/memory-directory.js):
//   list() / get(username) / create({ email, role }) / setRole / setEnabled / remove
// Users look like { username, email, role, enabled, status, created_at }.
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
  ListUsersInGroupCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { ADMIN_GROUP, OWNER_GROUP, roleOf } from "./auth.js";

const attr = (attributes = [], name) => attributes.find((a) => a.Name === name)?.Value;

function toUser(u, groups) {
  const attributes = u.Attributes ?? u.UserAttributes;
  return {
    username: u.Username,
    email: attr(attributes, "email"),
    role: roleOf(groups),
    enabled: u.Enabled,
    status: u.UserStatus, // FORCE_CHANGE_PASSWORD = invited, has not signed in yet
    created_at: u.UserCreateDate?.toISOString(),
  };
}

export function cognitoDirectory({ userPoolId, client = new CognitoIdentityProviderClient({}) }) {
  const base = { UserPoolId: userPoolId };
  const send = (Command, input) => client.send(new Command({ ...base, ...input }));

  async function usersInGroup(GroupName) {
    const users = [];
    let NextToken;
    do {
      const page = await send(ListUsersInGroupCommand, { GroupName, NextToken });
      users.push(...page.Users);
      NextToken = page.NextToken;
    } while (NextToken);
    return users;
  }

  async function get(username) {
    try {
      const [user, { Groups }] = await Promise.all([
        send(AdminGetUserCommand, { Username: username }),
        send(AdminListGroupsForUserCommand, { Username: username }),
      ]);
      const groups = Groups.map((g) => g.GroupName);
      return groups.includes(ADMIN_GROUP) ? toUser(user, groups) : null;
    } catch (err) {
      if (err.name === "UserNotFoundException") return null;
      throw err;
    }
  }

  return {
    get,

    async list() {
      const [members, owners] = await Promise.all([usersInGroup(ADMIN_GROUP), usersInGroup(OWNER_GROUP)]);
      const ownerNames = new Set(owners.map((u) => u.Username));
      return members
        .map((u) => toUser(u, ownerNames.has(u.Username) ? [OWNER_GROUP] : []))
        .sort((a, b) => a.email.localeCompare(b.email));
    },

    /** Cognito emails the invitation (temporary password); returns null when the email is taken. */
    async create({ email, role }) {
      let created;
      try {
        created = await send(AdminCreateUserCommand, {
          Username: email,
          DesiredDeliveryMediums: ["EMAIL"],
          UserAttributes: [{ Name: "email", Value: email }, { Name: "email_verified", Value: "true" }],
        });
      } catch (err) {
        if (err.name === "UsernameExistsException") return null;
        throw err;
      }
      const Username = created.User.Username;
      await send(AdminAddUserToGroupCommand, { Username, GroupName: ADMIN_GROUP });
      if (role === "owner") await send(AdminAddUserToGroupCommand, { Username, GroupName: OWNER_GROUP });
      return toUser(created.User, role === "owner" ? [OWNER_GROUP] : []);
    },

    async setRole(username, role) {
      if (role === "owner") await send(AdminAddUserToGroupCommand, { Username: username, GroupName: OWNER_GROUP });
      else await send(AdminRemoveUserFromGroupCommand, { Username: username, GroupName: OWNER_GROUP });
      if (role === "staff") await send(AdminUserGlobalSignOutCommand, { Username: username }); // drop refresh tokens carrying the old role
    },

    async setEnabled(username, enabled) {
      await send(enabled ? AdminEnableUserCommand : AdminDisableUserCommand, { Username: username });
      if (!enabled) await send(AdminUserGlobalSignOutCommand, { Username: username });
    },

    async remove(username) {
      await send(AdminDeleteUserCommand, { Username: username });
    },
  };
}
