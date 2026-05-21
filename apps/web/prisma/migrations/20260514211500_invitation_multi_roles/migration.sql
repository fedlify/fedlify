ALTER TABLE "Invitation" ADD COLUMN "roles" "StudyRole"[] NOT NULL DEFAULT ARRAY[]::"StudyRole"[];
UPDATE "Invitation" SET "roles" = ARRAY["role"]::"StudyRole"[] WHERE cardinality("roles") = 0;
