export type TwitterSegmentRole = 'original' | 'translation' | 'spacer' | 'normal';

export type TwitterSegmentLanguageKind = 'english' | 'chinese' | 'other';

export type TwitterClipKind = 'tweet' | 'tweet-longform' | 'x-article';

export interface TwitterTextSegment {
    html: string;
    text: string;
    textOnly?: boolean;
    role?: TwitterSegmentRole;
    groupId?: string;
}

export interface TranslationPairSegment {
    original: TwitterTextSegment[];
    translation: TwitterTextSegment[];
}
