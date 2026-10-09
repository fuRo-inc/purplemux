import Head from 'next/head';
import dynamic from 'next/dynamic';
import type { GetServerSideProps } from 'next';
import { SWRConfig } from 'swr';
import os from 'os';
import { getWorkspaces, createWorkspace } from '@/lib/workspace-store';
import { getConfig } from '@/lib/config-store';
import { readQuickPrompts } from '@/lib/quick-prompts-store';
import type { IQuickPromptsData } from '@/lib/quick-prompts-store';
import { readSidebarItems } from '@/lib/sidebar-items-store';
import type { ISidebarItemsData } from '@/lib/sidebar-items-store';
import type { IWorkspaceInitialData } from '@/hooks/use-workspace-store';
import type { IConfigInitialData } from '@/hooks/use-config-store';
import { initTerminalTheme } from '@/hooks/use-terminal-theme';
import { useEffect, useRef } from 'react';
import { useTheme } from 'next-themes';
import useIsMobile from '@/hooks/use-is-mobile';
import useBrowserTitle from '@/hooks/use-browser-title';
import { getPageShellLayout } from '@/components/layout/page-shell';
import { requireAuth } from '@/lib/require-auth';
import { loadMessagesServer } from '@/lib/load-messages';

const TerminalPage = dynamic(
  () => import('@/components/features/workspace/terminal-page'),
  { ssr: false },
);

const MobileTerminalPage = dynamic(
  () => import('@/components/features/mobile/mobile-terminal-page'),
  { ssr: false },
);

interface IIndexProps {
  initialWorkspace: IWorkspaceInitialData;
  initialConfig: IConfigInitialData;
  initialQuickPrompts: IQuickPromptsData;
  initialSidebarItems: ISidebarItemsData;
}

const Index = ({ initialConfig, initialQuickPrompts, initialSidebarItems }: IIndexProps) => {
  const isMobile = useIsMobile();
  const { setTheme } = useTheme();
  useBrowserTitle('purplemux');
  const themeInitRef = useRef(false);
  useEffect(() => {
    if (!themeInitRef.current) {
      themeInitRef.current = true;
      if (initialConfig.appTheme) {
        setTheme(initialConfig.appTheme);
      }
      if (initialConfig.terminalTheme) {
        initTerminalTheme(initialConfig.terminalTheme);
      }
    }
  }, [initialConfig, setTheme]);

  return (
    <SWRConfig value={{ fallback: { '/api/quick-prompts': initialQuickPrompts, '/api/sidebar-items': initialSidebarItems } }}>
      <Head>
        <title>purplemux</title>
      </Head>
      {isMobile ? <MobileTerminalPage /> : <TerminalPage />}
    </SWRConfig>
  );
};

Index.getLayout = getPageShellLayout;

export const getServerSideProps: GetServerSideProps<IIndexProps> = async (context) =>
  requireAuth(context, async () => {
    const [data, configData, quickPrompts, sidebarItems, messages] = await Promise.all([getWorkspaces(), getConfig(), readQuickPrompts(), readSidebarItems(), loadMessagesServer()]);

    if (data.workspaces.length === 0) {
      const ws = await createWorkspace(os.homedir());
      data.workspaces.push(ws);
      data.activeWorkspaceId = ws.id;
    }

    // Next.js getServerSideProps cannot serialize undefined values.
    // A fresh installation may not have a persisted active workspace yet.
    data.activeWorkspaceId ??= data.workspaces[0]?.id;

    const { authPassword, authSecret: _, ...safeConfig } = configData;
    const hostEnvLocked = typeof process.env.HOST === 'string' && process.env.HOST.trim().length > 0;
    const { isBoundToLocalhostOnly } = await import('@/lib/access-filter');
    const bindHostIsLocal = isBoundToLocalhostOnly();
    return { props: { initialWorkspace: data, initialConfig: { ...safeConfig, hasAuthPassword: !!authPassword, hostEnvLocked, bindHostIsLocal }, initialQuickPrompts: quickPrompts, initialSidebarItems: sidebarItems, messages } };
  });

export default Index;
