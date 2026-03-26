/**
 * Profile Page — Server mode with getServerData
 *
 * Rendered per-request on the server. Dynamic data based on URL params.
 */

export const page = {
  mode: 'server' as const,
  title: 'Profile',
};

export async function getServerData(ctx: { params: Record<string, string>; url: string; query: Record<string, string> }) {
  const username = ctx.params.username || 'unknown';
  return {
    username,
    displayName: username.charAt(0).toUpperCase() + username.slice(1),
    bio: `This is the profile page for ${username}.`,
    joinedAt: '2025-01-15T00:00:00Z',
    postCount: 42,
    requestUrl: ctx.url,
  };
}

export default function ProfilePage(props: {
  username: string;
  displayName: string;
  bio: string;
  joinedAt: string;
  postCount: number;
  requestUrl: string;
  params: Record<string, string>;
}) {
  return (
    <div class="profile">
      <h1>{props.displayName}</h1>
      <p class="bio">{props.bio}</p>

      <dl>
        <dt>Username</dt>
        <dd>@{props.username}</dd>

        <dt>Joined</dt>
        <dd>{props.joinedAt}</dd>

        <dt>Posts</dt>
        <dd>{props.postCount}</dd>

        <dt>Request URL</dt>
        <dd>{props.requestUrl}</dd>
      </dl>

      <p><a href="/">Back to Home</a></p>
    </div>
  );
}
