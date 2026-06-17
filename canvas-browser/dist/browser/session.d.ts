import { type Page } from "playwright-core";
export declare class PlasmicBrowserSession {
    private browser?;
    private page?;
    connect(debugUrl?: string): Promise<void>;
    findStudioPage(projectId: string): Promise<Page>;
    getPage(): Page;
    close(): Promise<void>;
}
export declare function withStudioPage<T>(projectId: string, fn: (page: Page) => Promise<T>): Promise<T>;
