import { createMDX } from 'fumadocs-mdx/next';
import { withBotId } from 'botid/next/config';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
};

// withBotId adds the BotID proxy rewrites; withMDX wraps the MDX pipeline.
export default withBotId(withMDX(config));
