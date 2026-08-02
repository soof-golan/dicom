import { Bullets, Callout, Emphasis, LegalPage, P, Section } from "./LegalLayout.tsx";

const summary = [
  "The viewer is not a medical device. Do not use it to diagnose or to treat anybody.",
  "The software comes with no warranty. You use it at your own risk.",
  "Your files stay on your device. You alone are responsible for them, and for the laws that cover them.",
  "The code and the demo scan are under the MIT License.",
  "These terms can change, and the viewer can go offline at any time.",
];

export function Terms() {
  return (
    <LegalPage title="Terms and Conditions" lastUpdated="2026-08-02" summary={summary}>
      <Callout heading="1. The viewer is not a medical device">
        <Emphasis>This is the most important clause on this page. Read it first.</Emphasis>
        <P>
          The viewer is not a medical device. No regulator certified, cleared, or approved it. This
          includes the FDA of the United States, the authorities under the EU MDR, and every other
          regulator in every other country.
        </P>
        <Emphasis>
          Do not use the viewer for diagnosis. Do not use it for treatment, for screening, or for
          any clinical decision. Do not use it to advise a patient.
        </Emphasis>
        <P>
          The viewer can show an image incorrectly. It can read a DICOM tag wrong. It can scale,
          orient, or color the data wrong. It can fail with no message on the screen. A colored
          region can look like a finding when no finding exists.
        </P>
        <P>
          A qualified doctor with certified equipment must read your medical images. The viewer is a
          tool for education, for software work, and for personal curiosity. It is nothing more.
        </P>
      </Callout>

      <Section heading="2. Agreement">
        <P>These terms are an agreement between you and Soof Golan, the owner of the viewer.</P>
        <P>
          Use of the viewer means that you accept these terms. If you do not accept them, do not use
          the viewer.
        </P>
      </Section>

      <Section heading="3. No warranty">
        <P>
          The viewer comes &ldquo;as is&rdquo; and &ldquo;as available&rdquo;. It comes with no
          warranty of any kind, express or implied.
        </P>
        <P>
          There is no warranty of merchantability. There is no warranty of fitness for a particular
          purpose. There is no warranty of non-infringement.
        </P>
        <P>
          I do not warrant that the viewer is accurate. I do not warrant that it is free of errors,
          that it runs without interruption, or that it reads every DICOM file correctly.
        </P>
        <P>You use the viewer at your own risk.</P>
      </Section>

      <Section heading="4. Limit of liability">
        <P>
          To the limit that the law allows, Soof Golan is not liable for any damage that comes from
          the viewer, or from the use of the viewer.
        </P>
        <P>This limit covers:</P>
        <Bullets
          items={[
            "direct, indirect, incidental, special, and consequential damage",
            "lost data, lost profit, lost time, and lost business",
            "personal injury, and harm to a patient",
            "damage from a wrong image, a wrong measurement, or a wrong segmentation",
          ]}
        />
        <P>
          This limit applies to every claim, in contract, in tort, or under any other legal theory.
          It applies even after somebody warns me that the damage can occur.
        </P>
        <P>
          Some countries do not allow a limit of this kind. In those countries, this limit applies
          as far as the law allows, and no further.
        </P>
      </Section>

      <Section heading="5. Your data and your legal duties">
        <P>
          Your files stay on your device. They never reach me. They never reach a server that I
          control.
        </P>
        <P>
          As a result, you hold all responsibility for the files that you open. You must hold the
          right to open them.
        </P>
        <P>
          Medical data laws can apply to you. HIPAA, GDPR, and similar laws are your duty, not mine.
          I never receive your data, so I am not a processor, a controller, or a business associate
          for it.
        </P>
        <P>
          If you open patient data on a shared computer, other people can read the screen. Control
          your own device.
        </P>
      </Section>

      <Section heading="6. License for the software">
        <P>
          The source code of the viewer is under the MIT License. Copyright (c) 2026 Soof Golan.
        </P>
        <P>
          You can use, copy, change, and distribute the code under that license. You must keep the
          copyright notice and the license text in every copy.
        </P>
        <P>
          The LICENSE file in the repository holds the full text. That text carries its own
          disclaimer of warranty, and it applies in addition to section 3.
        </P>
      </Section>

      <Section heading="7. The demo dataset">
        <P>
          The viewer offers a demo dataset. It is a de-identified MRI scan of my own right elbow. I
          publish it with my own consent.
        </P>
        <P>
          The demo dataset is under the MIT License, the same license as the code. You can view it,
          copy it, and use it in your own work. You must keep the copyright notice with it.
        </P>
        <P>
          Section 1 applies to the demo dataset too. It is an example for software work. It is not a
          reference for medical study, and it is not a normal scan.
        </P>
      </Section>

      <Section heading="8. Availability and accuracy">
        <P>
          I make no promise that the viewer stays online. I can change it, break it, or stop it at
          any time, with no notice.
        </P>
        <P>
          The demo dataset and the model file can disappear in the same way. Both depend on
          Cloudflare, and that service can fail.
        </P>
        <P>
          I make no promise that the output of the viewer is accurate. The tissue colors, the
          measurements, and the segmentation results are estimates from a computer program. Treat
          every one of them as unverified.
        </P>
      </Section>

      <Section heading="9. Changes to these terms">
        <P>
          These terms can change. The &ldquo;Last updated&rdquo; date at the top of this page shows
          the date of the last change.
        </P>
        <P>
          New terms apply from the day that I publish them. If you use the viewer after that day,
          you accept the new terms.
        </P>
        <P>
          The Git repository holds the full history of this file. You can read every earlier version
          there.
        </P>
      </Section>

      <Section heading="10. Contact">
        <P>Open an issue at github.com/soof-golan/dicom for a question about these terms.</P>
        <P>Read the Privacy Policy for what the viewer stores and what it sends.</P>
      </Section>
    </LegalPage>
  );
}
