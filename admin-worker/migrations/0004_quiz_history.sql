-- Mini App'da javoblar tarixini ko'rsatish uchun savol matni va olingan ballni saqlaymiz

ALTER TABLE quizzes ADD COLUMN question TEXT NOT NULL DEFAULT '';
ALTER TABLE quiz_answers ADD COLUMN points INTEGER NOT NULL DEFAULT 0;
